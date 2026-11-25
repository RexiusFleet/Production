// Rexius Production — "maps": address lookup and drive times for Bulk Dispatch, through Google.
// The Google key lives only in this project's secrets (GOOGLE_MAPS_KEY) and never reaches a browser.
// Only a signed-in Rexius account can call it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Suggestions lean toward the delivery area (Eugene / Springfield and the towns around it).
const CENTER = { latitude: 44.0521, longitude: -123.0868 };
const BIAS = { circle: { center: CENTER, radius: 50000 } };

async function signedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: Deno.env.get("SUPABASE_ANON_KEY") || "" },
  });
  if (!r.ok) return false;
  const u = await r.json().catch(() => null);
  return !!(u && u.id);
}

function parts(components: any[]) {
  const get = (type: string, short = false) => {
    const c = (components || []).find((x) => (x.types || []).includes(type));
    return c ? (short ? (c.shortText ?? c.short_name) : (c.longText ?? c.long_name)) || "" : "";
  };
  return {
    number: get("street_number"),
    street: get("route", true),
    city: get("locality") || get("sublocality") || get("postal_town") || get("administrative_area_level_3"),
    state: get("administrative_area_level_1", true),
    zip: get("postal_code"),
  };
}
const tidy = (s: string) => String(s || "").replace(/,\s*(USA|United States)$/i, "");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!(await signedIn(req))) return json({ error: "Sign in to use address lookup" }, 401);
    const url = new URL(req.url);
    const q = url.searchParams;
    const action = q.get("action") || "";
    const key = Deno.env.get("GOOGLE_MAPS_KEY") || "";
    if (action === "ping") return json({ ok: true, key: !!key });
    if (!key) return json({ error: "The Google key has not been added yet" });

    if (action === "places") {
      const input = (q.get("input") || "").slice(0, 120);
      if (input.trim().length < 3) return json({ predictions: [] });
      const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
        body: JSON.stringify({
          input, includedRegionCodes: ["us"], locationBias: BIAS, origin: CENTER,
          includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
          sessionToken: q.get("session") || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) return json({ error: "Google: " + (j?.error?.message || r.status) });
      const predictions = (j.suggestions || []).map((s: any) => s.placePrediction).filter(Boolean).map((p: any) => ({
        place_id: p.placeId,
        description: tidy(p.text?.text || ""),
        main: p.structuredFormat?.mainText?.text || "",
        secondary: tidy(p.structuredFormat?.secondaryText?.text || ""),
        street_only: (p.types || []).includes("route"),
        miles: p.distanceMeters != null ? Math.round(p.distanceMeters / 160.934) / 10 : null,
      }));
      return json({ predictions });
    }

    if (action === "place") {
      const id = q.get("id") || "";
      if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) return json({ error: "bad place id" }, 400);
      const s = q.get("session");
      const r = await fetch(`https://places.googleapis.com/v1/places/${id}${s ? `?sessionToken=${encodeURIComponent(s)}` : ""}`, {
        headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,formattedAddress,location,addressComponents,types" },
      });
      const j = await r.json();
      if (!r.ok) return json({ error: "Google: " + (j?.error?.message || r.status) });
      const p = parts(j.addressComponents);
      return json({
        formatted: tidy(j.formattedAddress), lat: j.location?.latitude ?? null, lng: j.location?.longitude ?? null,
        ...p, street_only: !p.number,
      });
    }

    if (action === "geocode") {
      const address = (q.get("address") || "").slice(0, 200);
      if (!address.trim()) return json({ error: "no address" }, 400);
      const u = "https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(address) +
        "&components=country:US&bounds=43.55,-123.75|44.45,-122.45&key=" + key;
      const j = await (await fetch(u)).json();
      if (j.status === "ZERO_RESULTS") return json({ error: "Google could not find that address" });
      if (j.status !== "OK") return json({ error: "Google: " + (j.error_message || j.status) });
      const g = j.results[0], p = parts(g.address_components);
      return json({
        lat: g.geometry.location.lat, lng: g.geometry.location.lng, formatted: tidy(g.formatted_address), ...p,
        exact: g.geometry.location_type === "ROOFTOP" || g.geometry.location_type === "RANGE_INTERPOLATED",
        partial: !!g.partial_match, street_only: !p.number,
      });
    }

    if (action === "matrix") {
      const wp = (p: number[]) => ({ waypoint: { location: { latLng: { latitude: p[0], longitude: p[1] } } } });
      const origins = JSON.parse(q.get("origins") || "[]"), destinations = JSON.parse(q.get("destinations") || "[]");
      if (!Array.isArray(origins) || !Array.isArray(destinations) || origins.length > 25 || destinations.length > 25)
        return json({ error: "too many points" }, 400);
      const r = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters" },
        body: JSON.stringify({ origins: origins.map(wp), destinations: destinations.map(wp), travelMode: "DRIVE" }),
      });
      const j = await r.json();
      if (!r.ok) return json({ error: "Google: " + (j?.error?.message || j?.[0]?.error?.message || r.status) });
      return json({ rows: (j || []).map((row: any) => ({
        originIndex: row.originIndex, destinationIndex: row.destinationIndex,
        duration: parseFloat(String(row.duration || "0").replace("s", "")), distanceMeters: row.distanceMeters || 0 })) });
    }
    return json({ error: "unknown action " + action }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
