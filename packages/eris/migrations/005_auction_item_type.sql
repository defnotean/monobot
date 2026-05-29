-- Persist the listed item's original inventory category on the auction row.
--
-- Why: at list time createAuction escrows the item OUT of the seller's
-- inventory (removeFromInventory), discarding its original item_type. On a
-- no-bid expiry, closeExpiredAuctions refunds the item — but without the
-- original type it had to re-grant under a lifecycle string ("auction_unsold"),
-- which gameVisuals.inventoryEmbed then groups under the wrong category. By
-- storing item_type on the auction row, the no-bid refund restores the item
-- under its real category.
--
-- The column is nullable so the JS degrades safely before this migration is
-- applied: createAuction first attempts the insert WITH item_type and, if
-- PostgREST rejects the unknown column, retries without it; closeExpiredAuctions
-- falls back to "auction" when auction.item_type is null/absent. No NOT NULL
-- violation either way.
--
-- Run against your Supabase project:
--   psql $DATABASE_URL -f packages/eris/migrations/005_auction_item_type.sql
-- Or paste into the Supabase SQL Editor.

ALTER TABLE eris_auctions
  ADD COLUMN IF NOT EXISTS item_type TEXT;
