/* glsl.js — GLSL chunks shared across rigs: hashing, noise, curl, tonemap. */
(function (Bench) {
  'use strict';

  const HASH = `
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  p3 += dot(p3, p3.yzx+33.33);
  return fract((p3.xx+p3.yz)*p3.zy);
}
vec3 hash33(vec3 p){
  p = fract(p*vec3(0.1031,0.1030,0.0973));
  p += dot(p, p.yxz+33.33);
  return fract((p.xxy+p.yxx)*p.zyx);
}
float hash13(vec3 p){
  p = fract(p*0.1031);
  p += dot(p, p.zyx+31.32);
  return fract((p.x+p.y)*p.z);
}`;

  // Gradient noise, 2D and 3D, plus fbm. Quintic interpolation both ways.
  const NOISE = `
float noise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  float a = dot(hash22(i)*2.0-1.0, f);
  float b = dot(hash22(i+vec2(1,0))*2.0-1.0, f-vec2(1,0));
  float c = dot(hash22(i+vec2(0,1))*2.0-1.0, f-vec2(0,1));
  float d = dot(hash22(i+vec2(1,1))*2.0-1.0, f-vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float noise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  float n000 = dot(hash33(i+vec3(0,0,0))*2.0-1.0, f-vec3(0,0,0));
  float n100 = dot(hash33(i+vec3(1,0,0))*2.0-1.0, f-vec3(1,0,0));
  float n010 = dot(hash33(i+vec3(0,1,0))*2.0-1.0, f-vec3(0,1,0));
  float n110 = dot(hash33(i+vec3(1,1,0))*2.0-1.0, f-vec3(1,1,0));
  float n001 = dot(hash33(i+vec3(0,0,1))*2.0-1.0, f-vec3(0,0,1));
  float n101 = dot(hash33(i+vec3(1,0,1))*2.0-1.0, f-vec3(1,0,1));
  float n011 = dot(hash33(i+vec3(0,1,1))*2.0-1.0, f-vec3(0,1,1));
  float n111 = dot(hash33(i+vec3(1,1,1))*2.0-1.0, f-vec3(1,1,1));
  return mix(mix(mix(n000,n100,u.x), mix(n010,n110,u.x), u.y),
             mix(mix(n001,n101,u.x), mix(n011,n111,u.x), u.y), u.z);
}
float fbm3(vec3 p, int octaves){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * noise3(p);
    p *= 2.02; a *= 0.5;
  }
  return s;
}`;

  // Divergence-free flow: curl of a vector potential built from 3 noise fields.
  // Divergence-free is what keeps particles from piling up in sinks.
  const CURL = `
vec3 potential(vec3 p, float t){
  return vec3(
    noise3(p + vec3(0.0, 0.0, t)),
    noise3(p + vec3(31.4, 17.2, t)),
    noise3(p + vec3(-19.7, 42.1, t))
  );
}
vec3 curlNoise(vec3 p, float t){
  const float e = 0.12;
  vec3 dx = vec3(e, 0.0, 0.0), dy = vec3(0.0, e, 0.0), dz = vec3(0.0, 0.0, e);
  vec3 px0 = potential(p - dx, t), px1 = potential(p + dx, t);
  vec3 py0 = potential(p - dy, t), py1 = potential(p + dy, t);
  vec3 pz0 = potential(p - dz, t), pz1 = potential(p + dz, t);
  float x = (py1.z - py0.z) - (pz1.y - pz0.y);
  float y = (pz1.x - pz0.x) - (px1.z - px0.z);
  float z = (px1.y - px0.y) - (py1.x - py0.x);
  return vec3(x, y, z) / (2.0 * e);
}`;

  const TONEMAP = `
vec3 aces(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c){
  return mix(c*12.92, 1.055*pow(max(c, 1e-5), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}
// Cheap film grain keyed off pixel + time; breaks up gradient banding in 8-bit.
float grain(vec2 uv, float t){
  return fract(sin(dot(uv*vec2(1231.5, 719.3) + t, vec2(12.9898, 78.233))) * 43758.5453);
}`;

  // Polynomial fits in the spirit of the perceptual field colormaps that
  // scientific viz uses — the source of this site's palette.
  const COLORMAP = `
vec3 rampCool(float t){  // indigo -> teal -> chartreuse
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.045, 0.035, 0.13);
  vec3 c1 = vec3(0.22, 0.28, 0.72);
  vec3 c2 = vec3(0.17, 0.77, 0.75);
  vec3 c3 = vec3(0.72, 0.90, 0.35);
  vec3 a = mix(c0, c1, smoothstep(0.0, 0.38, t));
  vec3 b = mix(a, c2, smoothstep(0.30, 0.72, t));
  return mix(b, c3, smoothstep(0.68, 1.0, t));
}
vec3 rampHot(float t){   // ember -> amber -> paper white
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.03, 0.012, 0.03);
  vec3 c1 = vec3(0.52, 0.09, 0.14);
  vec3 c2 = vec3(1.00, 0.42, 0.08);
  vec3 c3 = vec3(1.00, 0.92, 0.72);
  vec3 a = mix(c0, c1, smoothstep(0.0, 0.35, t));
  vec3 b = mix(a, c2, smoothstep(0.30, 0.75, t));
  return mix(b, c3, smoothstep(0.72, 1.0, t));
}`;

  Bench.glsl = { HASH, NOISE, CURL, TONEMAP, COLORMAP };
})(window.Bench);
