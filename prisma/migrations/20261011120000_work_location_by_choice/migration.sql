-- Location is now chosen by the person at the start of each shift, not
-- detected from the network (the team's VPN makes office and home identical).
-- The shift a choice was made for, so it is asked again on the next one.
-- Additive only: office_networks and location_override_basis stay, unused.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "location_session_id" TEXT;

