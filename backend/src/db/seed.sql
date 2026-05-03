-- Seed: Courses in and around Potsdam, NY + popular US courses

INSERT INTO courses (course_id, course_name, club_name, address, city, state, country, latitude, longitude) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'Clarkson University Golf Course', 'Clarkson University', '8 Clarkson Ave, Potsdam, NY 13699', 'Potsdam', 'NY', 'United States', 44.6669, -74.9838),
  ('a1000000-0000-0000-0000-000000000002', 'Higley Flow Golf Course', 'Higley Flow Golf', '442 Cold Brook Dr, Colton, NY 13625', 'Colton', 'NY', 'United States', 44.5503, -74.9264),
  ('a1000000-0000-0000-0000-000000000003', 'Gouverneur Golf Course', 'Gouverneur Country Club', '435 Scotch Settlement Rd, Gouverneur, NY 13642', 'Gouverneur', 'NY', 'United States', 44.3370, -75.4619),
  ('a1000000-0000-0000-0000-000000000004', 'Massena Country Club', 'Massena Country Club', '305 Hatfield Rd, Massena, NY 13662', 'Massena', 'NY', 'United States', 44.9356, -74.8918),
  ('a1000000-0000-0000-0000-000000000005', 'Ogdensburg Country Club', 'Ogdensburg Country Club', '1 Country Club Rd, Ogdensburg, NY 13669', 'Ogdensburg', 'NY', 'United States', 44.7021, -75.4963),
  ('a1000000-0000-0000-0000-000000000006', 'Leray Mansion Golf Course', 'Leray Mansion', '830 Remington Blvd, Fort Drum, NY 13602', 'Fort Drum', 'NY', 'United States', 44.0568, -75.7574),
  ('a1000000-0000-0000-0000-000000000007', 'Watertown Golf Club', 'Watertown Golf Club', '1 Golf Course Rd, Watertown, NY 13601', 'Watertown', 'NY', 'United States', 43.9748, -75.9138),
  ('a1000000-0000-0000-0000-000000000008', 'St. Lawrence University Golf Course', 'St. Lawrence University', '23 Romoda Dr, Canton, NY 13617', 'Canton', 'NY', 'United States', 44.5954, -75.1635),
  ('a1000000-0000-0000-0000-000000000009', 'Au Sable Club', 'Au Sable Club', 'Lake Placid, NY', 'Lake Placid', 'NY', 'United States', 44.2795, -73.9799),
  ('a1000000-0000-0000-0000-000000000010', 'Pebble Beach Golf Links', 'Pebble Beach', '1700 17-Mile Dr, Pebble Beach, CA 93953', 'Pebble Beach', 'CA', 'United States', 36.5683, -121.9480),
  ('a1000000-0000-0000-0000-000000000011', 'Augusta National Golf Club', 'Augusta National', '2604 Washington Rd, Augusta, GA 30904', 'Augusta', 'GA', 'United States', 33.5021, -82.0199),
  ('a1000000-0000-0000-0000-000000000012', 'Bethpage Black Course', 'Bethpage State Park', '99 Quaker Meeting House Rd, Farmingdale, NY 11735', 'Farmingdale', 'NY', 'United States', 40.7532, -73.4577),
  ('a1000000-0000-0000-0000-000000000013', 'TPC Sawgrass (Stadium)', 'TPC Sawgrass', '110 TPC Blvd, Ponte Vedra Beach, FL 32082', 'Ponte Vedra Beach', 'FL', 'United States', 30.1974, -81.3950),
  ('a1000000-0000-0000-0000-000000000014', 'Pinehurst No. 2', 'Pinehurst Resort', '1 Carolina Vista Dr, Pinehurst, NC 28374', 'Pinehurst', 'NC', 'United States', 35.1965, -79.4706);

-- Teeboxes for Clarkson University Golf Course
INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Blue', 'male', 71.2, 124, 6380, 18, 72),
  ('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'White', 'male', 69.1, 119, 6012, 18, 72),
  ('b1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', 'Red', 'female', 72.5, 126, 5401, 18, 72);

-- Holes for Clarkson Blue tees
INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap) VALUES
  ('b1000000-0000-0000-0000-000000000001', 1, 4, 380, 5),
  ('b1000000-0000-0000-0000-000000000001', 2, 3, 185, 17),
  ('b1000000-0000-0000-0000-000000000001', 3, 5, 530, 7),
  ('b1000000-0000-0000-0000-000000000001', 4, 4, 410, 1),
  ('b1000000-0000-0000-0000-000000000001', 5, 4, 395, 9),
  ('b1000000-0000-0000-0000-000000000001', 6, 3, 165, 15),
  ('b1000000-0000-0000-0000-000000000001', 7, 5, 520, 11),
  ('b1000000-0000-0000-0000-000000000001', 8, 4, 350, 13),
  ('b1000000-0000-0000-0000-000000000001', 9, 4, 405, 3),
  ('b1000000-0000-0000-0000-000000000001', 10, 4, 420, 2),
  ('b1000000-0000-0000-0000-000000000001', 11, 3, 175, 18),
  ('b1000000-0000-0000-0000-000000000001', 12, 5, 545, 8),
  ('b1000000-0000-0000-0000-000000000001', 13, 4, 370, 14),
  ('b1000000-0000-0000-0000-000000000001', 14, 4, 400, 4),
  ('b1000000-0000-0000-0000-000000000001', 15, 3, 195, 16),
  ('b1000000-0000-0000-0000-000000000001', 16, 5, 510, 12),
  ('b1000000-0000-0000-0000-000000000001', 17, 4, 365, 10),
  ('b1000000-0000-0000-0000-000000000001', 18, 4, 360, 6);

-- Teeboxes for Higley Flow
INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par) VALUES
  ('b1000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000002', 'Blue', 'male', 70.8, 122, 6250, 18, 72),
  ('b1000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000002', 'White', 'male', 68.5, 116, 5900, 18, 72);

-- Holes for Higley Flow Blue
INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap) VALUES
  ('b1000000-0000-0000-0000-000000000004', 1, 4, 365, 7),
  ('b1000000-0000-0000-0000-000000000004', 2, 5, 510, 11),
  ('b1000000-0000-0000-0000-000000000004', 3, 3, 170, 17),
  ('b1000000-0000-0000-0000-000000000004', 4, 4, 395, 1),
  ('b1000000-0000-0000-0000-000000000004', 5, 4, 380, 5),
  ('b1000000-0000-0000-0000-000000000004', 6, 3, 155, 15),
  ('b1000000-0000-0000-0000-000000000004', 7, 5, 530, 9),
  ('b1000000-0000-0000-0000-000000000004', 8, 4, 345, 13),
  ('b1000000-0000-0000-0000-000000000004', 9, 4, 400, 3),
  ('b1000000-0000-0000-0000-000000000004', 10, 4, 410, 2),
  ('b1000000-0000-0000-0000-000000000004', 11, 3, 180, 16),
  ('b1000000-0000-0000-0000-000000000004', 12, 5, 520, 10),
  ('b1000000-0000-0000-0000-000000000004', 13, 4, 360, 14),
  ('b1000000-0000-0000-0000-000000000004', 14, 4, 390, 4),
  ('b1000000-0000-0000-0000-000000000004', 15, 3, 165, 18),
  ('b1000000-0000-0000-0000-000000000004', 16, 5, 505, 12),
  ('b1000000-0000-0000-0000-000000000004', 17, 4, 355, 8),
  ('b1000000-0000-0000-0000-000000000004', 18, 4, 370, 6);

-- Teeboxes for Massena Country Club
INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par) VALUES
  ('b1000000-0000-0000-0000-000000000006', 'a1000000-0000-0000-0000-000000000004', 'Blue', 'male', 71.5, 125, 6445, 18, 72),
  ('b1000000-0000-0000-0000-000000000007', 'a1000000-0000-0000-0000-000000000004', 'White', 'male', 69.3, 120, 6050, 18, 72);

-- Holes for Massena Blue
INSERT INTO holes (teebox_id, hole_num, par, yardage, handicap) VALUES
  ('b1000000-0000-0000-0000-000000000006', 1, 4, 400, 3),
  ('b1000000-0000-0000-0000-000000000006', 2, 3, 190, 15),
  ('b1000000-0000-0000-0000-000000000006', 3, 5, 545, 9),
  ('b1000000-0000-0000-0000-000000000006', 4, 4, 385, 7),
  ('b1000000-0000-0000-0000-000000000006', 5, 4, 410, 1),
  ('b1000000-0000-0000-0000-000000000006', 6, 3, 175, 17),
  ('b1000000-0000-0000-0000-000000000006', 7, 5, 535, 11),
  ('b1000000-0000-0000-0000-000000000006', 8, 4, 360, 13),
  ('b1000000-0000-0000-0000-000000000006', 9, 4, 445, 5),
  ('b1000000-0000-0000-0000-000000000006', 10, 4, 415, 2),
  ('b1000000-0000-0000-0000-000000000006', 11, 3, 185, 16),
  ('b1000000-0000-0000-0000-000000000006', 12, 5, 550, 8),
  ('b1000000-0000-0000-0000-000000000006', 13, 4, 370, 14),
  ('b1000000-0000-0000-0000-000000000006', 14, 4, 395, 4),
  ('b1000000-0000-0000-0000-000000000006', 15, 3, 200, 18),
  ('b1000000-0000-0000-0000-000000000006', 16, 5, 520, 10),
  ('b1000000-0000-0000-0000-000000000006', 17, 4, 375, 12),
  ('b1000000-0000-0000-0000-000000000006', 18, 4, 390, 6);

-- Pebble Beach teeboxes
INSERT INTO teeboxes (teebox_id, course_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par) VALUES
  ('b1000000-0000-0000-0000-000000000010', 'a1000000-0000-0000-0000-000000000010', 'Championship', 'male', 75.5, 145, 6828, 18, 72);
