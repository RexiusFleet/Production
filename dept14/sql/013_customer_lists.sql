-- =====================================================================
-- Dept 14 - 013_customer_lists.sql
-- Customer lists for the type-ahead customer box on orders.
--   biochar_customers: Biological Carbon, Stormwater Biochar (Nate, 2026-11-05)
--   orchid_customers : the 111 customers in the Coburg Log "Specialty" tab
--                      (2021 on), spelling variants merged, plus three names
--                      only found in the dashboard's orders.
-- The manager (dashboard) and sales staff (sales page) add more as needed;
-- this only seeds the lists and never overwrites one that exists.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and Run. Safe to re-run.
-- Pure ASCII. Paste the check result back.
-- =====================================================================
begin;

insert into dept14.settings (key, value) values
  ('biochar_customers', '["Biological Carbon", "Stormwater Biochar"]'),
  ('orchid_customers', '["Alice Gong", "Arcadia Glasshouse", "Berry Woodson", "Bi-Mart", "Bird''s Botanicals", "Bonsai Jack", "Butterfly Palace", "BWI Distributors", "Byron Pike Nursery", "Candace Nakanishi", "Chadwick & Son Orchids", "Chicago Park District", "Chuck Botman", "Cinnabar Valley Farms", "City of Seattle", "Clouds orchids", "Concentrates", "Cybele Labs", "DBD Pet", "Dohse Aquaristic", "Don Baker", "Don Hawker", "Easy Plant", "Eddi''s Wholesale", "Eli Newton", "Elm Dirt", "Emerald City Orchids", "Euclid Nursery", "Fernseed", "Green Barn Orchid Supply", "Ground Up Soils", "Hail the Scale - Matt Frank", "Harvey Singleton", "Helmi''s Gardens", "Hillsview Gardens", "Huntington Botanical Gardens", "Hydrofarm", "HydroFarm Canada", "Indoor Sun Shoppe", "J&L Orchids", "Joel Loveland", "John Zukoff", "Josh''s Frogs", "Jungle House", "Kamal Kotaich", "Kellen Rodriguez", "Kelley''s Korner", "Lambert Peat Moss", "Le Paradis des Orchidees", "Let''s Grow Gard. & Hydr. Supply", "Little Brook Orchids", "Live Trends Design", "Lloyd Ousterhout", "Lord Fairfax Orchid Society", "Lori Rheinberger", "Matsui", "Matthew Sievert", "Mayer Materials", "Mega Mass", "Metro Plant and Flower", "Mimi Nursery", "Montana Marketing", "Mughal Plants Limited", "Murphy''s Orchids", "Natassa Bourkas", "Niu Nursery", "Norman Nakanishi", "Okie Orchids", "Orange County Farm Supply", "Orchid Grower Supply", "Orchid Species Preservation", "Orchid Supply Co.", "Orchid Supply Store", "Orchids by Hausermann", "Orchids Royale", "Paladin (Willgro)", "Paramount Orchids", "PF Harris", "Portland Orchid Society", "Powell Gardens", "Quarter Acre Orchids", "Repotme", "ReptiChip", "Robert Pham", "Rosy", "Rutgers University", "San Lorenzo Lumber and Home (Vicky)", "Sarah Bowen", "Scotts Canada", "Simple Hay", "Southland Floral", "Stadium Flowers", "Stony Hill Gardens", "Sumas", "Summerfield Orchids (Bob Harig)", "Sun Bulb", "Sunset Orchids", "Syndicate Sales", "T4 Orchids", "Terragreen Creations", "The Orchid Gallery", "Tiada Orchids", "Tom Harper", "Top Tier Genetics", "Tropical Paradise", "University of Washington", "Variant Plant Company", "Very Plants", "Victoria Smith", "Worldwide Orchids", "Zoo Med"]')
on conflict (key) do nothing;

commit;

-- Check: paste this back
select key as what, jsonb_array_length(value)::text || ' customers' as detail
  from dept14.settings where key in ('biochar_customers', 'orchid_customers') order by key;
