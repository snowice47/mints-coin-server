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

// ============================================================
// REQUIRED ENVIRONMENT VARIABLES
// ============================================================

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

// ============================================================
// DATABASE
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

// ============================================================
// APP
// ============================================================

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

// ============================================================
// DATABASE SETUP
// ============================================================

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_rewards (
      telegram_id BIGINT PRIMARY KEY,
      streak INTEGER NOT NULL DEFAULT 0,
      last_claim_date TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS level_rewards (
      telegram_id BIGINT NOT NULL,
      level INTEGER NOT NULL,
      reward BIGINT NOT NULL,
      claimed_at BIGINT NOT NULL,
      PRIMARY KEY (telegram_id, level)
    )
  `);
}

// ============================================================
// TELEGRAM VALIDATION
// ============================================================

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

  if (
    authDate > now + 60 ||
    now - authDate > 24 * 60 * 60
  ) {
    throw new Error("Telegram authorization expired");
  }

  params.delete("hash");

  const dataCheckString =
    [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

  const secretKey =
    crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

  const calculatedHash =
    crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

  const receivedBuffer =
    Buffer.from(receivedHash, "hex");

  const calculatedBuffer =
    Buffer.from(calculatedHash, "hex");

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

// ============================================================
// AUTHENTICATION
// ============================================================

function authenticate(req, res, next) {

  try {

    const initData =
      req.headers["x-telegram-init-data"];

    req.telegramUser =
      validateTelegramInitData(initData);

    next();

  } catch (error) {

    res.status(401).json({
      error: "Unauthorized"
    });
  }
}

// ============================================================
// ENERGY REGENERATION
// ============================================================

function calculateCurrentEnergy(user) {

  const now =
    Math.floor(Date.now() / 1000);

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

// ============================================================
// GET OR CREATE USER
// ============================================================

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

// ============================================================
// FORMAT USER
// ============================================================

function formatUser(user, currentEnergy = null) {

  return {
    telegramId: String(user.telegram_id),
    username: user.username,
    firstName: user.first_name,

    coins: Number(user.coins),

    energy:
      currentEnergy === null
        ? Number(user.energy)
        : Number(currentEnergy),

    maxEnergy: Number(user.max_energy),

    tapPower: Number(user.tap_power),

    autoMiner: Number(user.auto_miner),

    level: Number(user.level),

    totalTaps: Number(user.total_taps)
  };
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", async (req, res) => {

  try {

    await pool.query("SELECT 1");

    res.json({
      name: "Mints Coin API",
      status: "online",
      database: "connected"
    });

  } catch (error) {

    console.error(error);

    res.status(503).json({
      name: "Mints Coin API",
      status: "database_error"
    });
  }
});

// ============================================================
// AUTH
// ============================================================

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
        user:
          formatUser(
            user,
            currentEnergy
          )
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Authentication failed"
      });
    }
  }
);

// ============================================================
// GET PLAYER
// ============================================================

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

      res.json(
        formatUser(
          user,
          currentEnergy
        )
      );

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Could not load player"
      });
    }
  }
);

// ============================================================
// SECURE TAP
// ============================================================

app.post(
  "/api/tap",
  authenticate,
  async (req, res) => {

    const client = await pool.connect();

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

      const user = result.rows[0];

      const currentEnergy =
        calculateCurrentEnergy(user);

      if (currentEnergy < 1) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "No energy"
        });
      }

      const tapReward =
        Number(user.tap_power);

      const autoMinerReward =
        Number(user.auto_miner);

      const totalReward =
        tapReward + autoMinerReward;

      const newCoins =
        Number(user.coins) + totalReward;

      const newEnergy =
        currentEnergy - 1;

      const newTotalTaps =
        Number(user.total_taps) + 1;

      const newLevel =
        Math.floor(newCoins / 1000) + 1;

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
        maxEnergy: Number(user.max_energy),
        tapPower: totalReward,
        level: newLevel,
        totalTaps: newTotalTaps
      });

    } catch (error) {

      await client.query("ROLLBACK");

      console.error(
        "Tap error:",
        error
      );

      res.status(500).json({
        error: "Tap failed"
      });

    } finally {

      client.release();
    }
  }
);

// ============================================================
// DAILY REWARD
// ============================================================

app.post(
  "/api/rewards/daily",
  authenticate,
  async (req, res) => {

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      const telegramId =
        String(req.telegramUser.id);

      const rewardSchedule = [
        200,
        300,
        500,
        750,
        1000,
        1500,
        2500
      ];

      const today =
        new Date()
          .toISOString()
          .slice(0, 10);

      const rewardResult =
        await client.query(
          `
          SELECT *
          FROM daily_rewards
          WHERE telegram_id = $1
          FOR UPDATE
          `,
          [telegramId]
        );

      let streak = 0;
      let lastClaimDate = null;

      if (rewardResult.rows.length > 0) {

        streak =
          Number(
            rewardResult.rows[0].streak
          ) || 0;

        lastClaimDate =
          rewardResult.rows[0]
            .last_claim_date;
      }

      if (lastClaimDate === today) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error:
            "Daily reward already claimed"
        });
      }

      let nextStreak = 1;

      if (lastClaimDate) {

        const previous =
          new Date(
            `${lastClaimDate}T00:00:00Z`
          );

        const current =
          new Date(
            `${today}T00:00:00Z`
          );

        const difference =
          Math.floor(
            (
              current.getTime() -
              previous.getTime()
            ) /
            86400000
          );

        if (difference === 1) {
          nextStreak =
            streak + 1;
        }
      }

      if (nextStreak > 7) {
        nextStreak = 1;
      }

      const reward =
        rewardSchedule[
          nextStreak - 1
        ];

      const userResult =
        await client.query(
          `
          UPDATE users
          SET coins = coins + $1,
              level =
                FLOOR(
                  (coins + $1) / 1000
                ) + 1
          WHERE telegram_id = $2
          RETURNING
            coins,
            energy,
            max_energy,
            tap_power,
            auto_miner,
            level,
            total_taps
          `,
          [
            reward,
            telegramId
          ]
        );

      if (userResult.rows.length === 0) {

        throw new Error(
          "Player account not found"
        );
      }

      await client.query(
        `
        INSERT INTO daily_rewards (
          telegram_id,
          streak,
          last_claim_date
        )
        VALUES ($1, $2, $3)

        ON CONFLICT (telegram_id)
        DO UPDATE SET
          streak = EXCLUDED.streak,
          last_claim_date =
            EXCLUDED.last_claim_date
        `,
        [
          telegramId,
          nextStreak,
          today
        ]
      );

      await client.query("COMMIT");

      const updatedUser =
        userResult.rows[0];

      res.json({
        reward,
        streak: nextStreak,
        coins: Number(updatedUser.coins),
        energy: Number(updatedUser.energy),
        maxEnergy: Number(updatedUser.max_energy),
        tapPower: Number(updatedUser.tap_power),
        autoMiner: Number(updatedUser.auto_miner),
        level: Number(updatedUser.level),
        totalTaps: Number(updatedUser.total_taps)
      });

    } catch (error) {

      await client.query("ROLLBACK");

      console.error(
        "Daily reward error:",
        error
      );

      res.status(500).json({
        error:
          "Could not claim daily reward"
      });

    } finally {

      client.release();
    }
  }
);

// ============================================================
// LEVEL REWARDS
// LEVEL 1 = 1,000
// LEVEL 2 = 2,000
// ...
// LEVEL 10 = 10,000
// ============================================================

app.post(
  "/api/rewards/level",
  authenticate,
  async (req, res) => {

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      const telegramId =
        String(req.telegramUser.id);

      const requestedLevel =
        Number(req.body?.level);

      if (
        !Number.isInteger(requestedLevel) ||
        requestedLevel < 1 ||
        requestedLevel > 10
      ) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error:
            "Invalid reward level"
        });
      }

      const reward =
        requestedLevel * 1000;

      const userResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE telegram_id = $1
          FOR UPDATE
          `,
          [telegramId]
        );

      if (userResult.rows.length === 0) {

        await client.query("ROLLBACK");

        return res.status(404).json({
          error:
            "Player not found"
        });
      }

      const user =
        userResult.rows[0];

      const currentLevel =
        Number(user.level);

      if (
        currentLevel <
        requestedLevel
      ) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error:
            `You have not reached Level ${requestedLevel}`
        });
      }

      const claimResult =
        await client.query(
          `
          SELECT level
          FROM level_rewards
          WHERE telegram_id = $1
            AND level = $2
          FOR UPDATE
          `,
          [
            telegramId,
            requestedLevel
          ]
        );

      if (claimResult.rows.length > 0) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error:
            `Level ${requestedLevel} reward already claimed`
        });
      }

      const updatedUser =
        await client.query(
          `
          UPDATE users
          SET coins = coins + $1
          WHERE telegram_id = $2
          RETURNING
            coins,
            energy,
            max_energy,
            tap_power,
            auto_miner,
            level,
            total_taps
          `,
          [
            reward,
            telegramId
          ]
        );

      const now =
        Math.floor(Date.now() / 1000);

      await client.query(
        `
        INSERT INTO level_rewards (
          telegram_id,
          level,
          reward,
          claimed_at
        )
        VALUES ($1, $2, $3, $4)
        `,
        [
          telegramId,
          requestedLevel,
          reward,
          now
        ]
      );

      await client.query("COMMIT");

      const player =
        updatedUser.rows[0];

      res.json({
        success: true,
        level: requestedLevel,
        reward,
        coins: Number(player.coins),
        energy: Number(player.energy),
        maxEnergy: Number(player.max_energy),
        tapPower: Number(player.tap_power),
        autoMiner: Number(player.auto_miner),
        levelCurrent: Number(player.level),
        totalTaps: Number(player.total_taps)
      });

    } catch (error) {

      await client.query("ROLLBACK");

      console.error(
        "Level reward error:",
        error
      );

      res.status(500).json({
        error:
          "Could not claim level reward"
      });

    } finally {

      client.release();
    }
  }
);

// ============================================================
// GET CLAIMED LEVEL REWARDS
// ============================================================

app.get(
  "/api/rewards/level/claimed",
  authenticate,
  async (req, res) => {

    try {

      const telegramId =
        String(req.telegramUser.id);

      const result =
        await pool.query(
          `
          SELECT level
          FROM level_rewards
          WHERE telegram_id = $1
          ORDER BY level ASC
          `,
          [telegramId]
        );

      const claimedLevels =
        result.rows.map(
          (row) =>
            Number(row.level)
        );

      res.json({
        claimedLevels
      });

    } catch (error) {

      console.error(
        "Could not load claimed level rewards:",
        error
      );

      res.status(500).json({
        error:
          "Could not load claimed rewards"
      });
    }
  }
);

// ============================================================
// BOOST: MULTITAP
// COST = CURRENT TAP POWER × 100
// EFFECT = +1 TAP POWER
// ============================================================

app.post(
  "/api/boost/multitap",
  authenticate,
  async (req, res) => {

    const client = await pool.connect();

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
          "Player not found"
        );
      }

      const user = result.rows[0];

      const cost =
        Number(user.tap_power) * 100;

      if (Number(user.coins) < cost) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error:
            `You need ${cost.toLocaleString()} MINTS`
        });
      }

      const newCoins =
        Number(user.coins) - cost;

      const newTapPower =
        Number(user.tap_power) + 1;

      const updated =
        await client.query(
          `
          UPDATE users
          SET coins = $1,
              tap_power = $2
          WHERE telegram_id = $3
          RETURNING
            coins,
            energy,
            max_energy,
            tap_power,
            auto_miner,
            level,
            total_taps
          `,
          [
            newCoins,
            newTapPower,
            telegramId
          ]
        );

      await client.query("COMMIT");

      const player =
        updated.rows[0];

      res.json({
        success: true,
        coins: Number(player.coins),
        energy: Number(player.energy),
        maxEnergy: Number(player.max_energy),
        tapPower: Number(player.tap_power),
        autoMiner: Number(player.auto_miner),
        level: Number(player.level),
        totalTaps: Number(player.total_taps)
      });

    } catch (error) {

      await client.query("ROLLBACK");

      console.error(
        "Multitap boost error:",
        error
      );

      res.status(500).json({
        error:
          "Could not upgrade tap power"
      });

    } finally {

      client.release();
    }
  }
);

// ============================================================
// BOOST: ENERGY CAPACITY
// EFFECT = +500 MAX ENERGY
// ============================================================

app.post(
  "/api/boost/energy",
  authenticate,
  async (req, res) => {

    const client = await pool.connect();

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
          "Player not found"
        );
      }

      const user = result.rows[0];

      const currentMax =
        Number(user.max_energy);

      const cost =
        Math.floor(
          (currentMax / 1000) * 500
        );

      if (Number(user.coins) < cost) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error:
            `You need ${cost.toLocaleString()} MINTS`
        });
      }

      const newCoins =
        Number(user.coins) - cost;

      const newMaxEnergy =
        currentMax + 500;

      const newEnergy =
        Math.min(
          newMaxEnergy,
          Number(user.energy)
        );

      const now =
        Math.floor(Date.now() / 1000);

      const updated =
        await client.query(
          `
          UPDATE users
          SET coins = $1,
              max_energy = $2,
              energy = $3,
              last_energy_update = $4
          WHERE telegram_id = $5
          RETURNING
            coins,
            energy,
            max_energy,
            tap_power,
            auto_miner,
            level,
            total_taps
          `,
          [
            newCoins,
            newMaxEnergy,
            newEnergy,
            now,
            telegramId
          ]
        );

      await client.query("COMMIT");

      const player =
        updated.rows[0];

      res.json({
        success: true,
        coins: Number(player.coins),
        energy: Number(player.energy),
        maxEnergy: Number(player.max_energy),
        tapPower: Number(player.tap_power),
        autoMiner: Number(player.auto_miner),
        level: Number(player.level),
        totalTaps: Number(player.total_taps)
      });

    } catch (error) {

      await client.query("ROLLBACK");

      console.error(
        "Energy boost error:",
        error
      );

      res.status(500).json({
        error:
          "Could not upgrade energy"
      });

    } finally {

      client.release();
    }
  }
);

// ============================================================
// BOOST: AUTO MINER
// COST = (CURRENT AUTO MINER + 1) × 2,000
// EFFECT = +1 AUTO MINER
// ============================================================

app.post(
  "/api/boost/auto-miner",
  authenticate,
  async (req, res) => {

    const client = await pool.connect();

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
          "Player not found"
        );
      }

      const user = result.rows[0];

      const currentAutoMiner =
        Number(user.auto_miner);

      const cost =
        (currentAutoMiner + 1) * 2000;

      if (Number(user.coins) < cost) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error:
            `You need ${cost.toLocaleString()} MINTS`
        });
      }

      const newCoins =
        Number(user.coins) - cost;

      const newAutoMiner =
        currentAutoMiner + 1;

      const updated =
        await client.query(
          `
          UPDATE users
          SET coins = $1,
              auto_miner = $2
          WHERE telegram_id = $3
          RETURNING
            coins,
            energy,
            max_energy,
            tap_power,
            auto_miner,
            level,
            total_taps
          `,
          [
            newCoins,
            newAutoMiner,
            telegramId
          ]
        );

      await client.query("COMMIT");

      const player =
        updated.rows[0];

      res.json({
        success: true,
        coins: Number(player.coins),
        energy: Number(player.energy),
        maxEnergy: Number(player.max_energy),
        tapPower: Number(player.tap_power),
        autoMiner: Number(player.auto_miner),
        level: Number(player.level),
        totalTaps: Number(player.total_taps)
      });

    } catch (error) {

      await client.query("ROLLBACK");

      console.error(
        "Auto miner error:",
        error
      );

      res.status(500).json({
        error:
          "Could not upgrade auto miner"
      });

    } finally {

      client.release();
    }
  }
);

// ============================================================
// BOOST: INSTANT ENERGY
// COST = 50 MINTS
// EFFECT = FULL ENERGY
// ============================================================

app.post(
  "/api/boost/energy-restore",
  authenticate,
  async (req, res) => {

    const client = await pool.connect();

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
          "Player not found"
        );
      }

      const user = result.rows[0];

      const cost = 50;

      if (
        Number(user.energy) >=
        Number(user.max_energy)
      ) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error:
            "Energy is already full"
        });
      }

      if (Number(user.coins) < cost) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          error:
            `You need ${cost} MINTS`
        });
      }

      const newCoins =
        Number(user.coins) - cost;

      const newEnergy =
        Number(user.max_energy);

      const now =
        Math.floor(Date.now() / 1000);

      const updated =
        await client.query(
          `
          UPDATE users
          SET coins = $1,
              energy = $2,
              last_energy_update = $3
          WHERE telegram_id = $4
          RETURNING
            coins,
            energy,
            max_energy,
            tap_power,
            auto_miner,
            level,
            total_taps
          `,
          [
            newCoins,
            newEnergy,
            now,
            telegramId
          ]
        );

      await client.query("COMMIT");

      const player =
        updated.rows[0];

      res.json({
        success: true,
        coins: Number(player.coins),
        energy: Number(player.energy),
        maxEnergy: Number(player.max_energy),
        tapPower: Number(player.tap_power),
        autoMiner: Number(player.auto_miner),
        level: Number(player.level),
        totalTaps: Number(player.total_taps)
      });

    } catch (error) {

      await client.query("ROLLBACK");

      console.error(
        "Energy restore error:",
        error
      );

      res.status(500).json({
        error:
          "Could not restore energy"
      });

    } finally {

      client.release();
    }
  }
);

// ============================================================
// SERVER ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(error);

    res.status(500).json({
      error:
        "Internal server error"
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

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

start().catch(
  (error) => {

    console.error(
      "Failed to start Mints Coin API:",
      error
    );

    process.exit(1);
  }
);