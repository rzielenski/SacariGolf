#!/usr/bin/env node
/**
 * Imports courses, teeboxes, and holes from the old Supabase backup into Railway Postgres.
 * Usage: node scripts/migrate-courses.js <PUBLIC_DATABASE_URL>
 * Example: node scripts/migrate-courses.js "postgresql://postgres:pass@roundhouse.proxy.rlwy.net:12345/railway"
 */

const { Client } = require('pg');
const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const path = require('path');

const BACKUP_PATH = 'C:/Users/Richard/Downloads/db_cluster-21-08-2025@06-17-21.backup.gz';
const DATABASE_URL = process.argv[2];

if (!DATABASE_URL) {
  console.error('Usage: node scripts/migrate-courses.js <PUBLIC_DATABASE_URL>');
  process.exit(1);
}

// Parse a COPY format line (tab-separated, \N = null)
function parseCopyLine(line, columns) {
  const values = line.split('\t');
  const obj = {};
  columns.forEach((col, i) => {
    obj[col] = values[i] === '\\N' ? null : values[i];
  });
  return obj;
}

// Extract COPY block for a given table
function extractCopyBlock(lines, tableName) {
  const rows = [];
  let columns = [];
  let inBlock = false;

  for (const line of lines) {
    if (!inBlock) {
      const match = line.match(new RegExp(`COPY public\\.\"${tableName}\"\\s*\\(([^)]+)\\)\\s*FROM stdin`));
      if (match) {
        columns = match[1].split(',').map(c => c.trim());
        inBlock = true;
      }
    } else {
      if (line === '\\.') break;
      rows.push(parseCopyLine(line, columns));
    }
  }
  return rows;
}

async function batchInsert(client, table, columns, rows, batchSize = 500) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const placeholders = batch.map((_, bi) =>
      `(${columns.map((_, ci) => `$${bi * columns.length + ci + 1}`).join(', ')})`
    ).join(', ');
    const values = batch.flatMap(row => columns.map(col => row[col] ?? null));
    try {
      await client.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
        values
      );
      inserted += batch.length;
      process.stdout.write(`\r  ${inserted}/${rows.length}`);
    } catch (e) {
      console.error(`\n  Batch error at ${i}: ${e.message}`);
    }
  }
  console.log();
}

async function main() {
  console.log('Reading backup file...');
  const raw = fs.readFileSync(BACKUP_PATH);
  const decompressed = zlib.gunzipSync(raw).toString('utf8');
  const lines = decompressed.split('\n');
  console.log(`Read ${lines.length.toLocaleString()} lines`);

  console.log('Parsing courses...');
  const courses = extractCopyBlock(lines, 'Courses');
  console.log(`  Found ${courses.length.toLocaleString()} courses`);

  console.log('Parsing teeboxes...');
  const teeboxes = extractCopyBlock(lines, 'Teeboxes');
  console.log(`  Found ${teeboxes.length.toLocaleString()} teeboxes`);

  console.log('Parsing holes...');
  const holes = extractCopyBlock(lines, 'Holes');
  console.log(`  Found ${holes.length.toLocaleString()} holes`);

  console.log('\nConnecting to Railway...');
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected.');

  console.log('\nInserting courses...');
  await batchInsert(client, 'courses',
    ['course_id', 'course_name', 'club_name', 'address', 'city', 'state', 'country', 'latitude', 'longitude'],
    courses.map(r => ({
      course_id: r.course_id,
      course_name: r.course_name,
      club_name: r.club_name,
      address: r.address,
      city: r.city,
      state: r.state,
      country: r.country,
      latitude: r.latitude ? parseFloat(r.latitude) : null,
      longitude: r.longitude ? parseFloat(r.longitude) : null,
    }))
  );

  console.log('Inserting teeboxes...');
  await batchInsert(client, 'teeboxes',
    ['teebox_id', 'course_id', 'name', 'gender', 'course_rating', 'slope_rating', 'total_yards', 'num_holes', 'par',
     'front_course_rating', 'front_slope_rating', 'back_course_rating', 'back_slope_rating'],
    teeboxes.map(r => ({
      teebox_id: r.teebox_id,
      course_id: r.course_id,
      name: r.name,
      gender: r.gender,
      course_rating: r.course_rating ? parseFloat(r.course_rating) : null,
      slope_rating: r.slope_rating ? parseInt(r.slope_rating) : null,
      total_yards: r.total_yards ? parseInt(r.total_yards) : null,
      num_holes: r.num_holes ? parseInt(r.num_holes) : 18,
      par: r.par ? parseInt(r.par) : 72,
      front_course_rating: r.front_course_rating ? parseFloat(r.front_course_rating) : null,
      front_slope_rating: r.front_slope_rating ? parseInt(r.front_slope_rating) : null,
      back_course_rating: r.back_course_rating ? parseFloat(r.back_course_rating) : null,
      back_slope_rating: r.back_slope_rating ? parseInt(r.back_slope_rating) : null,
    }))
  );

  console.log('Inserting holes...');
  await batchInsert(client, 'holes',
    ['hole_id', 'teebox_id', 'hole_num', 'par', 'yardage', 'handicap'],
    holes
      .filter(r => r.par != null && r.hole_num != null && r.teebox_id != null)
      .map(r => ({
        hole_id: r.hole_id,
        teebox_id: r.teebox_id,
        hole_num: parseInt(r.hole_num),
        par: parseInt(r.par),
        yardage: r.yardage ? parseInt(r.yardage) : null,
        handicap: r.handicap ? parseInt(r.handicap) : null,
      }))
  );

  await client.end();
  console.log('\nDone! All data imported.');
}

main().catch(e => { console.error(e); process.exit(1); });
