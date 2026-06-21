import React, { useMemo } from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import { MAPBOX_TOKEN, MAPBOX_STYLE } from '../lib/mapbox';

/**
 * Course3DView — the Phase 1 "3D course view": Mapbox satellite draped on 3D
 * terrain, with shots as 3D arcs (deck.gl ArcLayer) flying above the ground.
 * Rendered in a WebView (react-native-maps can't fly lines above terrain).
 *
 * It is SELF-DIAGNOSING: if the map can't render (no token, no WebGL, CDN load
 * failure, bad token), it shows the reason on screen and posts it to RN, rather
 * than a silent black box. The token is injected at runtime from lib/mapbox.
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
  const pad = 0.0008; // never let the box be degenerate (1 shot / identical pts)
  const bounds = [
    [Math.min(...lngs) - pad, Math.min(...lats) - pad],
    [Math.max(...lngs) + pad, Math.max(...lats) + pad],
  ];
  const head = (tee && pin) ? bearing(tee, pin)
    : (shots.length ? bearing(shots[0].start, shots[shots.length - 1].end) : 0);
  const cfg = { token: MAPBOX_TOKEN, style: MAPBOX_STYLE, shots, pin, bounds, bearing: head };
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link href="https://cdn.jsdelivr.net/npm/mapbox-gl@3/dist/mapbox-gl.css" rel="stylesheet" />
<style>
  html,body{margin:0;height:100%;width:100%;background:#0b0e14;overflow:hidden}
  #map{position:absolute;inset:0}
  .mapboxgl-canvas{width:100%!important;height:100%!important}
  #status{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;color:#cfd3c8;font:600 14px -apple-system,Segoe UI,Roboto,sans-serif;padding:0 26px;line-height:1.5;z-index:5}
</style>
</head><body>
<div id="map"></div>
<div id="status">Loading 3D course…</div>
<script>
var C=${JSON.stringify(cfg)};
function post(o){try{if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}
function setStatus(t,err){var s=document.getElementById('status');if(!s)return;if(t===null){s.style.display='none';return;}s.style.display='block';s.textContent=t;s.style.color=err?'#ff9a9a':'#cfd3c8';}
function hx(h){h=(h||'#f0c95a').replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
function load(src){return new Promise(function(res,rej){var el=document.createElement('script');el.src=src;el.onload=function(){res();};el.onerror=function(){rej(new Error('load failed: '+src));};document.head.appendChild(el);});}
(function(){
  if(!C.token){setStatus('No Mapbox token found. Set EXPO_PUBLIC_MAPBOX_TOKEN, then restart with: npx expo start -c',true);post({type:'error',msg:'no token'});return;}
  var cv=document.createElement('canvas');
  if(!(cv.getContext('webgl2')||cv.getContext('webgl'))){setStatus('This WebView has no WebGL, so the 3D map cannot render here. Use a dev build on a real device.',true);post({type:'error',msg:'no webgl'});return;}
  setStatus('Loading map engine…');
  load('https://cdn.jsdelivr.net/npm/mapbox-gl@3/dist/mapbox-gl.js')
    .then(function(){return load('https://cdn.jsdelivr.net/npm/deck.gl@9/dist.min.js');})
    .then(function(){
      if(!window.mapboxgl){throw new Error('mapbox-gl missing after load');}
      setStatus('Starting map…');
      mapboxgl.accessToken=C.token;
      var map=new mapboxgl.Map({container:'map',style:C.style,bounds:C.bounds,fitBoundsOptions:{padding:55},antialias:true,attributionControl:false});
      var wd=setTimeout(function(){setStatus('Map did not finish loading. Usually a WebView origin/worker limit in Expo Go; a dev build fixes it.',true);post({type:'error',msg:'load timeout'});},14000);
      map.on('idle',function(){setStatus(null);});
      map.on('load',function(){
        clearTimeout(wd);
        try{map.addSource('dem',{type:'raster-dem',url:'mapbox://mapbox.mapbox-terrain-dem-v1',tileSize:512,maxzoom:14});map.setTerrain({source:'dem',exaggeration:1.3});map.setFog({'color':'rgb(186,180,160)','horizon-blend':0.18,'high-color':'rgb(76,98,120)','space-color':'rgb(16,20,28)','star-intensity':0});}catch(e){}
        try{map.easeTo({pitch:66,bearing:C.bearing,duration:0});}catch(e){}
        try{
          if(window.deck&&deck.MapboxOverlay){
            var arcs=new deck.ArcLayer({id:'arcs',data:C.shots,getSourcePosition:function(d){return [d.start.lng,d.start.lat];},getTargetPosition:function(d){return [d.end.lng,d.end.lat];},getSourceColor:function(d){return hx(d.color).concat([240]);},getTargetColor:function(){return [255,255,255,240];},getWidth:4,getHeight:0.5});
            var dots=new deck.ScatterplotLayer({id:'dots',data:C.shots,getPosition:function(d){return [d.start.lng,d.start.lat];},getFillColor:function(d){return hx(d.color).concat([255]);},radiusUnits:'pixels',getRadius:4,stroked:true,getLineColor:[255,255,255,255],lineWidthMinPixels:1.5});
            map.addControl(new deck.MapboxOverlay({layers:[arcs,dots]}));
          }
        }catch(e){post({type:'warn',msg:'arcs failed: '+(e&&e.message)});}
        if(C.pin){try{var pole=document.createElement('div');pole.style.cssText='position:absolute;left:0;bottom:0;width:2px;height:22px;background:#eee';var fl=document.createElement('div');fl.style.cssText='position:absolute;left:2px;top:0;width:0;height:0;border-top:6px solid transparent;border-bottom:6px solid transparent;border-left:11px solid #e8772f';var w=document.createElement('div');w.style.cssText='position:relative;width:13px;height:22px';w.appendChild(pole);w.appendChild(fl);new mapboxgl.Marker({element:w,anchor:'bottom'}).setLngLat([C.pin.lng,C.pin.lat]).addTo(map);}catch(e){}}
        setStatus(null);
        post({type:'ready'});
      });
      map.on('error',function(e){var m=(e&&e.error&&e.error.message)||'map error';setStatus('Map error: '+m,true);post({type:'error',msg:m});});
    })
    .catch(function(err){setStatus('Could not load the 3D map engine. Check the connection. ('+(err&&err.message||err)+')',true);post({type:'error',msg:String(err&&err.message||err)});});
})();
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
        // A real https origin is REQUIRED: with raw `{ html }` the document
        // origin is null, and Mapbox's tile/style web workers silently fail to
        // start, so the map hangs forever at "Starting map" with no error.
        // Using the site's own origin also lets a URL-restricted token work.
        source={{ html, baseUrl: 'https://sacarigolf.com' }}
        style={styles.fill}
        javaScriptEnabled
        domStorageEnabled
        androidLayerType="hardware"
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
        onMessage={(e) => {
          try {
            const d = JSON.parse(e.nativeEvent.data);
            if (d?.type === 'error') console.warn('[Course3DView]', d.msg);
            else if (d?.type === 'warn') console.warn('[Course3DView]', d.msg);
          } catch { /* ignore */ }
        }}
        onError={(e) => console.warn('[Course3DView] webview error:', e.nativeEvent?.description)}
        onHttpError={(e) => console.warn('[Course3DView] http error:', e.nativeEvent?.statusCode)}
      />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, overflow: 'hidden' } });
