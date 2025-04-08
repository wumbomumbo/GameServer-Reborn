import express from "express";
import routes from "./routes/routes.js";

import compression from "compression";

import chalk from "chalk";
import { debugWithTime } from "./util/debugUtil.js";

import "dotenv/config";
import config from "../config.json" with { type: "json" };
const configFilePath = "./config.json";

import fs from "fs";
import sqlite3 from "sqlite3";

import { randomBytes } from "crypto";
import JSZip from 'jszip';

const db = new sqlite3.Database(
  config.dataDirectory + "/users.db",
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, // Make the database file if it doesn't already exist
  (error) => {
    if (error) {
      console.error("[index.js] Error opening database:", error.message);
    }
  },
);

// Make a key for the admin dashboard if it doesn't already exist
if (!config.adminKey) config.adminKey = randomBytes(32).toString("hex"); // Random key that looks similar to a SHA256 hash
fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2)); // Update the file too, since "config.adminKey = " just changes it in memory

// Reset log
if (fs.existsSync("latest.log"))
  fs.rmSync("latest.log");

const app = express();
const PORT = process.env.LISTEN_PORT || config.listenPort;

// Disable unnecessary Express features
app.disable("x-powered-by");
app.disable("etag");

// Setup Pug
app.set("view engine", "pug");
app.set("views", "./src/views");

const QUERY =
  "CREATE TABLE IF NOT EXISTS UserData (MayhemId int unique, UserId int unique, UserName text unique, UserEmail text unique, UserCred int, UserAccessToken string unique, UserAccessCode string unique, UserRefreshToken string unique, SessionId string unique, SessionKey string unique, WholeLandToken string, LandSavePath string, CurrencySavePath string);";
db.run(QUERY, async (error) => {
  // Make sure database is initialized
  if (error) {
    console.error("Could not initialize database: ", error.message);
    return;
  }
});

db.close((error) => {
  if (error) {
    console.error("Error closing database:", error.message);
    return;
  }
});

app.use((req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode !== 404 || config.verbose) {
      debugWithTime(0, chalk.blue(req.method) + ` ${req.originalUrl} ` + chalk.magenta(`[${res.statusCode}]`));
    }
  });
  next();
});

app.use(
  compression({
    filter: () => true,
    threshold: 0,
    level: 6, // Good balance between compression ratio and CPU usage
  }),
);

app.use(routes);

if (config.serveDlcsLocally) {
  debugWithTime(0, "Serving DLCs from local directory: " + config.localDlcFolder);

  if (!fs.existsSync(config.localDlcFolder)) {
    fs.mkdirSync(config.localDlcFolder);
  }

  app.use("/dlc", express.static(config.localDlcFolder));
} else {
  debugWithTime(1, "DLCs will not be served from a local directory.");
}

app.get("/", (req, res) => {
  res.send("Hello, World!");
});

app.get("/dlc/dlc/DLCIndex.zip", async (req, res, next) => {
  try {
    const clientVersion = req.header('client_version') || req.query.client_version;
    const zip = new JSZip();

    const masterXml = fs.readFileSync('indexes/DLCIndex.xml', 'utf8');

    const xmlParts = masterXml.split(/(<MasterDLCIndex>|<\/MasterDLCIndex>)/);
    const beforeMaster = xmlParts[0].trim();
    const masterOpen = xmlParts[1].trim();
    const masterContent = xmlParts[2].trim();
    const masterClose = xmlParts[3].trim();

    const overridesMatch = masterContent.match(/<Overrides>[\s\S]*?<\/Overrides>/);
    const overridesSection = overridesMatch ? overridesMatch[0].trim() : '';
    const indexFiles = masterContent.match(/<IndexFile[^>]+>/g) || [];

    let latestVersion = null;
    let latestIndexFile = '';
    let validIndexFiles = [];

    indexFiles.forEach(file => {
      const versionMatch = file.match(/version="([\d.]+)"/);
      if (versionMatch) {
        const version = versionMatch[1];
        if (parseFloat(version) <= parseFloat(clientVersion)) {
          if (!latestVersion || parseFloat(version) > parseFloat(latestVersion)) {
            if (latestIndexFile) {
              validIndexFiles.push(latestIndexFile.trim());
            }
            latestVersion = version;
            latestIndexFile = file.trim();
          } else {
            validIndexFiles.push(file.trim());
          }
        }
      }
    });

    const reconstructedXml = [
      beforeMaster,
      masterOpen,
      latestIndexFile ? '  ' + latestIndexFile : '',
      overridesSection,
      ...validIndexFiles.map(file => '  ' + file),
      masterClose
    ].filter(Boolean).join('\n');

    zip.file("DLCIndex.xml", reconstructedXml);

    const zipBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE"
    });

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename=DLCIndex.zip'
    });

    res.send(zipBuffer);

  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).send("Do'h! Error 404");
});

app.use((err, req, res, next) => {
  debugWithTime(2, err);
  res.status(500).send("Do'h! Error 500");
});

app.listen(PORT, () => {
  debugWithTime(0, `Listening on port ${PORT}`);
  global.running = true; // For the dashboard
  global.lobbyTime = 0; // 0 for current time
});
