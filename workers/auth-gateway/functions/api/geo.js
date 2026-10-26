import { json } from '../_kernel/http.js';
export async function onRequest(context) {
  const cf = context.request.cf || {};
  return json(200, {
    city: cf.city || null,
    latitude: cf.latitude || null,
    longitude: cf.longitude || null,
    timezone: cf.timezone || null,
  });
}
