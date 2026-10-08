export async function onRequest(context) {
  const cf = context.request.cf || {};
  return Response.json({
    city: cf.city || null,
    latitude: cf.latitude || null,
    longitude: cf.longitude || null,
    timezone: cf.timezone || null,
  });
}
