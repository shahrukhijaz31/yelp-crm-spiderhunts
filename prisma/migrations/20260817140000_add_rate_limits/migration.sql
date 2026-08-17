-- The whole of the authenticated rate limiter's state (lib/rateLimit.ts): one
-- row per (action, user), holding the count so far and when the window opened.
--
-- No foreign key to `users` on purpose. The key is an opaque string composed by
-- the application, the table holds no user data, and a rate limit that fails
-- because a row it references was deleted mid-window would be a limiter with a
-- new failure mode and no new guarantee. Deleting a user simply leaves at most
-- one stale row per action, which the next window for a reused id overwrites.
--
-- `window_started_at` is written with the database's `now()`, never the
-- application's clock: the two PM2 workers must agree about when a window
-- opened even if their system clocks do not.
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "window_started_at" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);
