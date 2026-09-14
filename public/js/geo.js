/**
 * Browser geolocation, shaped for a check-in button.
 *
 * The first fix a phone returns is often a cached, low-accuracy one from the
 * network provider, which is exactly what would put an employee "at the
 * office" from home. So we watch for a short window and keep the best fix,
 * stopping early once it is accurate enough to trust.
 */

const GOOD_ENOUGH_ACCURACY = 35;
const WATCH_TIMEOUT_MS = 12000;

export const supported = () => "geolocation" in navigator;

export const GEO_ERRORS = {
  1: "Location permission is blocked. Allow location for this site in your browser settings, then try again.",
  2: "Your device could not determine a location. Move somewhere with a clearer view of the sky and try again.",
  3: "Getting your location took too long. Try again.",
};

/** One quick fix, for the ambient "how far am I?" display. */
export function currentPosition({ timeout = 10000, maximumAge = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!supported()) {
      reject(new Error("This browser cannot share your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(toPoint(position)),
      (error) => reject(new Error(GEO_ERRORS[error.code] || "We couldn't read your location.")),
      { enableHighAccuracy: true, timeout, maximumAge }
    );
  });
}

/**
 * The fix used for an actual punch: high accuracy, never cached, and given a
 * few seconds to improve before we commit it to a record.
 */
export function bestPosition({ timeout = WATCH_TIMEOUT_MS, target = GOOD_ENOUGH_ACCURACY, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!supported()) {
      reject(new Error("This browser cannot share your location."));
      return;
    }

    let best = null;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      navigator.geolocation.clearWatch(watchId);
      clearTimeout(timer);
      if (best) resolve(best);
      else reject(error || new Error("We couldn't get an accurate location. Please try again."));
    };

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const point = toPoint(position);
        if (!best || point.accuracy < best.accuracy) best = point;
        if (onProgress) onProgress(best);
        if (best.accuracy <= target) finish();
      },
      (error) => {
        // Keep waiting if we already have something usable; a transient error
        // shouldn't throw away a good fix.
        if (best) finish();
        else finish(new Error(GEO_ERRORS[error.code] || "We couldn't read your location."));
      },
      { enableHighAccuracy: true, timeout, maximumAge: 0 }
    );

    const timer = setTimeout(() => finish(), timeout);
  });
}

const toPoint = (position) => ({
  lat: position.coords.latitude,
  lng: position.coords.longitude,
  accuracy: Math.round(position.coords.accuracy || 0),
  at: position.timestamp,
});

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Same haversine as the server, so the UI's distance matches the decision. */
export function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance to the nearest configured office, for the ambient status line. */
export function nearestOffice(point, offices) {
  if (!point || !offices || offices.length === 0) return null;
  return offices
    .map((office) => ({ office, distance: Math.round(distanceMeters(point, office)) }))
    .sort((a, b) => a.distance - b.distance)[0];
}
