/* Rexius core — connection settings shared by the hub and every app.
 * Both values are PUBLIC by design (they only identify the project; sign-in
 * and row-level security decide what anyone can see). Never put a secret or
 * service_role key in this file. */
window.REXIUS_CONFIG = Object.freeze({
  supabaseUrl: "https://fxajnoeoclnbggbkkpxn.supabase.co",
  supabaseKey: "sb_publishable_-i9tHyAX1eZ75-qw7CmYAA_vdAZ1RRr",
  hubPath: "/Production/hub/"
});
