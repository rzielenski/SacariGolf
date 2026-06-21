import React, { useMemo } from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import { MAPBOX_TOKEN, MAPBOX_STYLE } from '../lib/mapbox';

/**
 * Course3DView — the Phase 1 "3D course view": Mapbox satellite draped on 3D
 * terrain, with shots drawn as 3D arcs (deck.gl ArcLayer) flying above the
 * ground. Rendered inside a WebView so we get the full web 3D map stack, which
 * react-native-maps cannot do (it can't fly lines above terrain). It's a
 * drop-in replacement for the 2D map slot: same shot data in, a 3D view out.
 *
 * The token is injected at runtime from lib/mapbox (env-sourced), never
 * hardcoded. Callers should only mount this when HAS_MAPBOX is true and fall
 * back to the 2D map otherwise.
 */
type LL = { lat: number; lng: number };
export type Shot3D = { start: LL; end: LL; color?: string };

function bearing(a: LL, b: LL): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const g = (x: number) => (x * 180) / Math.PI;
  const dL = r(b.lng - a.lng);
  const y = Math.sin(dL) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(dL);
  return (g(Math.atan2(y, x)) + 360) % 360;
}

function buildHtml(shots: Shot3D[], pin: LL | null, tee: LL | null): string {
  const pts: LL[] = shots.flatMap((s) => [s.start, s.end]);
  if (pin) pts.push(pin);
  if (tee) pts.push(tee);
  const lngs = pts.map((p) => p.lng);
  const lats = pts.map((p) => p.lat);
  const bounds = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
  const head = (tee && pin) ? bearing(tee, pin)
    : (shots.length ? bearing(shots[0].start, shots[shots.length - 1].end) : 0);
  const cfg = { token: MAPBOX_TOKEN, style: MAPBOX_STYLE, shots, pin, bounds, bearing: head };
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link href="https://unpkg.com/mapbox-gl@3/dist/mapbox-gl.css" rel="stylesheet" />
<script src="https://unpkg.com/mapbox-gl@3/dist/mapbox-gl.js"></script>
<script src="https://unpkg.com/deck.gl@9/dist.min.js"></script>
<style>html,body,#map{margin:0;height:100%;width:100%;background:#0b0e14;overflow:hidden}</style>
</head><body><div id="map"></div><script>
var C=${JSON.stringify(cfg)};
function post(o){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(o));}
function hx(h){h=(h||'#f0c95a').replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
try{
mapboxgl.accessToken=C.token;
var map=new mapboxgl.Map({container:'map',style:C.style,bounds:C.bounds,fitBoundsOptions:{padding:55},antialias:true,attributionControl:false});
map.on('load',function(){
  try{
    map.addSource('dem',{type:'raster-dem',url:'mapbox://mapbox.mapbox-terrain-dem-v1',tileSize:512,maxzoom:14});
    map.setTerrain({source:'dem',exaggeration:1.3});
    map.setFog({'color':'rgb(186,180,160)','horizon-blend':0.18,'high-color':'rgb(76,98,120)','space-color':'rgb(16,20,28)','star-intensity':0});
  }catch(e){}
  map.easeTo({pitch:66,bearing:C.bearing,duration:0});
  var arcs=new deck.ArcLayer({id:'arcs',data:C.shots,
    getSourcePosition:function(d){return [d.start.lng,d.start.lat];},
    getTargetPosition:function(d){return [d.end.lng,d.end.lat];},
    getSourceColor:function(d){return hx(d.color).concat([240]);},
    getTargetColor:function(){return [255,255,255,240];},
    getWidth:4,getHeight:0.5});
  var dots=new deck.ScatterplotLayer({id:'dots',data:C.shots,
    getPosition:function(d){return [d.start.lng,d.start.lat];},
    getFillColor:function(d){return hx(d.color).concat([255]);},
    radiusUnits:'pixels',getRadius:4,stroked:true,getLineColor:[255,255,255,255],lineWidthMinPixels:1.5});
  map.addControl(new deck.MapboxOverlay({layers:[arcs,dots]}));
  if(C.pin){var pole=document.createElement('div');pole.style.cssText='position:absolute;left:0;bottom:0;width:2px;height:22px;background:#eee';var fl=document.createElement('div');fl.style.cssText='position:absolute;left:2px;top:0;width:0;height:0;border-top:6px solid transparent;border-bottom:6px solid transparent;border-left:11px solid #e8772f';var w=document.createElement('div');w.style.cssText='position:relative;width:13px;height:22px';w.appendChild(pole);w.appendChild(fl);new mapboxgl.Marker({element:w,anchor:'bottom'}).setLngLat([C.pin.lng,C.pin.lat]).addTo(map);}
  post({type:'ready'});
});
map.on('error',function(e){post({type:'error',msg:(e&&e.error&&e.error.message)||'map error'});});
}catch(err){post({type:'error',msg:String(err)});}
</script></body></html>`;
}

export function Course3DView({ shots, pin, tee, style }: {
  shots: Shot3D[];
  pin?: LL | null;
  tee?: LL | null;
  style?: StyleProp<ViewStyle>;
}) {
  const html = useMemo(() => buildHtml(shots, pin ?? null, tee ?? null), [shots, pin, tee]);
  return (
    <View style={[styles.fill, style]}>
      <WebView
        originWhitelist={['*']}
        source={{ html }}
        style={styles.fill}
        javaScriptEnabled
        domStorageEnabled
        androidLayerType="hardware"
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
      />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, overflow: 'hidden' } });
