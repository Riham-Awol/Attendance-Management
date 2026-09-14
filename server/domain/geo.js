"use strict";

const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres between two WGS-84 points.
 * Haversine is accurate to well under a metre at office-geofence scale,
 * which is all we need to answer "is this person at the office?".
 */
function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isValidCoordinate(point) {
  return (
    !!point &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

/**
 * Pick the office whose geofence the reader is inside, preferring the closest.
 *
 * `accuracy` is the browser's reported radius of confidence in metres. A phone
 * indoors can easily report 500m of uncertainty, so we widen the fence by the
 * reported accuracy up to `accuracySlackMeters` — beyond that we would be
 * accepting a check-in from anywhere in the neighbourhood, so we reject and
 * ask the user to move somewhere with a better fix.
 */
function resolveOffice(point, offices, options = {}) {
  const { accuracySlackMeters = 75, maxAccuracyMeters = 200 } = options;

  if (!isValidCoordinate(point)) {
    return { ok: false, reason: "invalid_coordinates" };
  }

  const accuracy = Number.isFinite(point.accuracy) ? point.accuracy : 0;
  if (accuracy > maxAccuracyMeters) {
    return { ok: false, reason: "poor_accuracy", accuracy };
  }

  const active = (offices || []).filter((o) => o.active !== false);
  if (active.length === 0) {
    return { ok: false, reason: "no_offices_configured" };
  }

  const measured = active
    .map((office) => ({
      office,
      distance: distanceMeters(point, { lat: office.lat, lng: office.lng }),
    }))
    .sort((a, b) => a.distance - b.distance);

  const slack = Math.min(accuracy, accuracySlackMeters);
  const inside = measured.find(
    (m) => m.distance <= (m.office.radiusMeters || 100) + slack
  );

  if (!inside) {
    const nearest = measured[0];
    return {
      ok: false,
      reason: "outside_geofence",
      nearestOffice: nearest.office,
      distance: Math.round(nearest.distance),
      allowedRadius: nearest.office.radiusMeters || 100,
    };
  }

  return {
    ok: true,
    office: inside.office,
    distance: Math.round(inside.distance),
    accuracy: Math.round(accuracy),
  };
}

module.exports = { distanceMeters, isValidCoordinate, resolveOffice, EARTH_RADIUS_M };
