const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;

const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN ||
  "https://snowice47.github.io";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

// ---------------------------------------------------------
// DATABASE
// ---------------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

// ---------------------------------------------------------
// APP
// ---------------------------------------------------------

app.set("trust proxy", 1);

app.use(
  cors({
    origin: FRONTEND_ORIGIN
  })
);

app.use(
  express.json({
    limit: "20kb"
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// ---------------------------------------------------------
// DATABASE INITIALIZATION
// ---------------------------------------------------------

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT NOT NULL DEFAULT '',
      coins BIGINT NOT NULL DEFAULT 0,
      energy INTEGER NOT NULL DEFAULT 1000,
      max_energy INTEGER NOT NULL DEFAULT 1000,
      tap_power INTEGER NOT NULL DEFAULT 1,
      auto_miner INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      total_taps BIGINT NOT NULL DEFAULT 0,
      last_energy_update BIGINT NOT NULL,
      last_seen BIGINT NOT NULL
    )
  `);
}

// ---------------------------------------------------------
// TELEGRAM INIT DATA VALIDATION
// ---------------------------------------------------------

function validateTelegramInitData(initData) {
  if (!initData || typeof initData !== "string") {
    throw new Error("Missing Telegram initData");
  }

  const params = new URLSearchParams(initData);

  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!receivedHash || !authDate) {
    throw new Error("Invalid Telegram data");
  }

  const now = Math.floor(Date.now() / 1000);

  // Don't accept very old authentication data.
  if (
    authDate > now + 60 ||
    now - authDate > 24 * 60 * 60
  ) {
    throw new Error("Telegram authorization expired");
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const receivedBuffer = Buffer.from(receivedHash, "hex");
  const calculatedBuffer = Buffer.from(calculatedHash, "hex");

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(
      calculatedBuffer,
      receivedBuffer
    )
  ) {
    throw new Error(
      "Telegram signature verification failed"
    );
  }

  const userJson = params.get("user");

  if (!userJson) {
    throw new Error("Telegram user missing");
  }

  let user;

  try {
    user = JSON.parse(userJson);
  } catch {
    throw new Error("Invalid Telegram user");
  }

  if (!user.id) {
    throw new Error("Telegram user ID missing");
  }

  return user;
}

// ---------------------------------------------------------
// AUTH MIDDLEWARE
// ---------------------------------------------------------

function authenticate(req, res, next) {
  try {
    const initData =
      req.headers["x-telegram-init-data"];

    const telegramUser =
      validateTelegramInitData(initData);

    req.telegramUser = telegramUser;

    next();
  } catch (error) {
    res.status(401).json({
      error: "Unauthorized"
    });
  }
}

// ---------------------------------------------------------
// ENERGY REGENERATION
// ---------------------------------------------------------

function calculateCurrentEnergy(user) {
  const now = Math.floor(Date.now() / 1000);

  const elapsed =
    Math.max(
      0,
      now - Number(user.last_energy_update)
    );

  const regenerated =
    Math.floor(elapsed);

  return Math.min(
    Number(user.max_energy),
    Number(user.energy) + regenerated
  );
}

// ---------------------------------------------------------
// GET OR CREATE USER
// ---------------------------------------------------------

async function getOrCreateUser(telegramUser) {
  const telegramId =
    String(telegramUser.id);

  const now =
    Math.floor(Date.now() / 1000);

  let result = await pool.query(
    `
    SELECT *
    FROM users
    WHERE telegram_id = $1
    `,
    [telegramId]
  );

  if (result.rows.length === 0) {
    await pool.query(
      `
      INSERT INTO users (
        telegram_id,
        username,
        first_name,
        last_energy_update,
        last_seen
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        telegramId,
        telegramUser.username || null,
        telegramUser.first_name || "",
        now,
        now
      ]
    );
  } else {
    await pool.query(
      `
      UPDATE users
      SET username = $1,
          first_name = $2,
          last_seen = $3
      WHERE telegram_id = $4
      `,
      [
        telegramUser.username || null,
        telegramUser.first_name || "",
        now,
        telegramId
      ]
    );
  }

  result = await pool.query(
    `
    SELECT *
    FROM users
    WHERE telegram_id = $1
    `,
    [telegramId]
  );

  return result.rows[0];
}

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------

app.get("/", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      name: "Mints Coin API",
      status: "online",
      database: "connected"
    });
  } catch {
    res.status(503).json({
      name: "Mints Coin API",
      status: "database_error"
    });
  }
});

// ---------------------------------------------------------
// LOGIN
// ---------------------------------------------------------

app.post(
  "/api/auth",
  authenticate,
  async (req, res) => {
    try {
      const user =
        await getOrCreateUser(
          req.telegramUser
        );

      const currentEnergy =
        calculateCurrentEnergy(user);

      const now =
        Math.floor(Date.now() / 1000);

      await pool.query(
        `
        UPDATE users
        SET energy = $1,
            last_energy_update = $2
        WHERE telegram_id = $3
        `,
        [
          currentEnergy,
          now,
          String(req.telegramUser.id)
        ]
      );

      res.json({
        user: {
          telegramId:
            String(user.telegram_id),

          username:
            user.username,

          firstName:
            user.first_name,

          coins:
            Number(user.coins),

          energy:
            currentEnergy,

          maxEnergy:
            Number(user.max_energy),

          tapPower:
            Number(user.tap_power),

          autoMiner:
            Number(user.auto_miner),

          level:
            Number(user.level),

          totalTaps:
            Number(user.total_taps)
        }
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Authentication failed"
      });
    }
  }
);

// ---------------------------------------------------------
// GET CURRENT PLAYER
// ---------------------------------------------------------

app.get(
  "/api/me",
  authenticate,
  async (req, res) => {
    try {
      const user =
        await getOrCreateUser(
          req.telegramUser
        );

      const currentEnergy =
        calculateCurrentEnergy(user);

      const now =
        Math.floor(Date.now() / 1000);

      await pool.query(
        `
        UPDATE users
        SET energy = $1,
            last_energy_update = $2
        WHERE telegram_id = $3
        `,
        [
          currentEnergy,
          now,
          String(req.telegramUser.id)
        ]
      );

      res.json({
        telegramId:
          String(user.telegram_id),

        username:
          user.username,

        firstName:
          user.first_name,

        coins:
          Number(user.coins),

        energy:
          currentEnergy,

        maxEnergy:
          Number(user.max_energy),

        tapPower:
          Number(user.tap_power),

        autoMiner:
          Number(user.auto_miner),

        level:
          Number(user.level),

        totalTaps:
          Number(user.total_taps)
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Could not load player"
      });
    }
  }
);

// ---------------------------------------------------------
// SECURE TAP
// ---------------------------------------------------------

app.post(
  "/api/tap",
  authenticate,
  async (req, res) => {

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const telegramId =
        String(req.telegramUser.id);

      const result =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          FOR UPDATE
          `,
          [telegramId]
        );

      if (result.rows.length === 0) {
        throw new Error(
          "Player account not found"
        );
      }

      const user =
        result.rows[0];

      const currentEnergy =
        calculateCurrentEnergy(user);

      if (currentEnergy < 1) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "No energy"
        });
      }

      const reward =
        Number(user.tap_power);

      const newCoins =
        Number(user.coins) + reward;

      const newEnergy =
        currentEnergy - 1;

      const newTotalTaps =
        Number(user.total_taps) + 1;

      const newLevel =
        Math.floor(
          newCoins / 1000
        ) + 1;

      const now =
        Math.floor(Date.now() / 1000);

      await client.query(
        `
        UPDATE users
        SET coins = $1,
            energy = $2,
            total_taps = $3,
            level = $4,
            last_energy_update = $5,
            last_seen = $6
        WHERE telegram_id = $7
        `,
        [
          newCoins,
          newEnergy,
          newTotalTaps,
          newLevel,
          now,
          now,
          telegramId
        ]
      );

      await client.query("COMMIT");

      res.json({
        coins: newCoins,
        energy: newEnergy,
        maxEnergy:
          Number(user.max_energy),
        tapPower: reward,
        level: newLevel,
        totalTaps: newTotalTaps
      });

    } catch (error) {
      await client.query("ROLLBACK");

      console.error(error);

      res.status(500).json({
        error: "Tap failed"
      });

    } finally {
      client.release();
    }
  }
);

// ---------------------------------------------------------
// ERROR HANDLER
// ---------------------------------------------------------

app.use(
  (error, req, res, next) => {
    console.error(error);

    res.status(500).json({
      error: "Internal server error"
    });
  }
);

// ---------------------------------------------------------
// START
// ---------------------------------------------------------

async function start() {
  await initializeDatabase();

  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `Mints Coin API running on port ${PORT}`
      );
    }
  );
}

start().catch((error) => {
  console.error(
    "Failed to start server:",
    error
  );

  process.exit(1);
});