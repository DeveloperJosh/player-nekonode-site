import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import GogoCDN from './lib/gogocdn.js';
import StreamWish from './lib/streamWish.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import winston from 'winston';
import { setCache, getCache, delCache } from './utils/redis.js';

dotenv.config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send("User-agent: *\nDisallow: /");
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, './views'));

const servers = {
  gogocdn: new GogoCDN(),
  streamwish: new StreamWish(),
  // Add other servers here
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});

app.use(limiter);
app.use(morgan('combined'));

// Setup Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: './src/logs/errors/error.log', level: 'error' }),
    new winston.transports.File({ filename: './src/logs/combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

async function fallbackHandler(anime) {
  const response = await axios.get(`https://api-anime.sziwyz.easypanel.host/anime/gogoanime/watch/${anime}`);
  return response.data;
}

app.get('/', async (req, res) => {
  const { anime_id, server } = req.query;

  if (!anime_id || !server) {
    logger.error('[GET /] Missing required parameters', { anime_id, server });
    return res.status(400).render('error', { message: 'Missing required parameters' });
  }

  if (!servers[server]) {
    logger.error('[GET /] Invalid server', { server });
    return res.status(400).render('error', { message: 'Invalid server' });
  }

  try {
    const ep_id = anime_id;
    const cacheKey = `${server}-${ep_id}`;
    const cachedData = await getCache(cacheKey);

    if (cachedData) {
      const { videoUrl, qualities } = JSON.parse(cachedData);
      logger.info('[GET /] Serving video from cache', { videoUrl });
      return res.render('index', { videoUrl, qualities });
    }

    const sources = await servers[server].getEpisodeSources(ep_id);

    if (!sources || sources.length === 0) {
      logger.warn('[GET /] No sources available');
      return res.status(404).render('error', { message: 'No sources available' });
    }

    const qualities = sources.map(source => ({ quality: source.quality, url: source.url }));
    const index = qualities.findIndex(quality => quality.quality === 'backup' || quality.quality === 'default');
    if (index > -1) {
      qualities.splice(index, 1);
    }
    const videoUrl = qualities[0].url;
    logger.info('[GET /] Streaming video', { videoUrl, server, anime_id });

    const cacheData = JSON.stringify({ videoUrl, qualities });
    await setCache(cacheKey, cacheData);
    res.render('index', { videoUrl, qualities });
  } catch (error) {
    logger.error('[GET /] Error getting video URL from primary server', { error: error.message });
    try {
      const fallbackResponse = await fallbackHandler(anime_id);
      const fallbackSources = fallbackResponse.sources;

      if (!fallbackSources || fallbackSources.length === 0) {
        await delCache(cacheKey);
        logger.warn('[GET /] No fallback sources available');
        return res.status(404).render('error', { message: 'No fallback sources available' });
      }

      const qualities = fallbackSources.map(source => ({ quality: source.quality, url: source.url }));
      const fallbackVideoUrl = qualities[0].url;

      logger.info('[GET /] Serving fallback video URL', { fallbackVideoUrl });
      const cacheData = JSON.stringify({ videoUrl: fallbackVideoUrl, qualities });
      await setCache(cacheKey, cacheData);
      return res.render('index', { videoUrl: fallbackVideoUrl, qualities });
    } catch (fallbackError) {
      logger.error('[GET /] Error getting video URL from fallback server', { fallbackError: fallbackError.message });
      res.status(500).render('error', { message: 'Failed to get video URL from both primary and fallback servers' });
    }
  }
});

app.get('/sources', async (req, res) => {
  const { anime_id } = req.query;

  if (!anime_id) {
    logger.error('[GET /sources] Missing required parameters', { anime_id });
    return res.status(400).render('error', { message: 'Missing required parameters' });
  }

  const ep_id = `${anime_id}`;
  const cacheKey = `sources-${ep_id}`;

  const cachedData = await getCache(cacheKey);
  if (cachedData) {
    logger.info('[GET /sources] Serving sources from cache', { ep_id });
    return res.json(cachedData);
  }

  const results = {};
  const serverPromises = Object.keys(servers).map(async server => {
    try {
      const sources = await servers[server].getEpisodeSources(ep_id);
      results[server] = sources.length ? sources : { error: 'No sources found' };
    } catch (error) {
      logger.error(`[GET /sources] Error getting sources from ${server}`, { error: error.message });
      results[server] = { error: 'Failed to get sources' };
    }
  });

  await Promise.all(serverPromises);

  const hasErrors = Object.values(results).some(result => result.error);

  if (!hasErrors) {
    await setCache(cacheKey, results);
  }

  logger.info('[GET /sources] URL', { url: `sources?anime_id=${anime_id}` });
  res.json(results);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});
