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
  message: 'Too many requests from this IP, please try again after 15 minutes'
});

app.use(limiter);
app.use(morgan('combined'));

// Setup Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
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
  const { anime_id, quality, server } = req.query;

  if (!anime_id || !quality || !server) {
    logger.error('[GET /] Missing required parameters', { anime_id, quality, server });
    return res.status(400).render('error', { message: 'Missing required parameters' });
  }

  if (!servers[server]) {
    logger.error('[GET /] Invalid server', { server });
    return res.status(400).render('error', { message: 'Invalid server' });
  }

  try {
    const ep_id = anime_id;
    const cacheKey = `${server}-${ep_id}-${quality}`;
    const cachedVideoUrl = await getCache(cacheKey);

    if (cachedVideoUrl) {
      logger.info('[GET /] Serving video URL from cache', { videoUrl: cachedVideoUrl });
      return res.render('index', { videoUrl: cachedVideoUrl });
    }

    const sources = await servers[server].getEpisodeSources(ep_id);
    const source = sources.find(src => src.quality === quality);

    if (!source) {
      const availableQualities = sources.map(src => src.quality);
      logger.warn('[GET /] Requested quality not available', { quality, availableQualities });
      return res.status(404).render('error', { message: 'Requested quality not available', availableQualities });
    }

    const videoUrl = source.url;
    logger.info('[GET /] Streaming video', { videoUrl, server, anime_id, quality });

    await setCache(cacheKey, videoUrl);
    res.render('index', { videoUrl });
  } catch (error) {
    logger.error('[GET /] Error getting video URL from primary server', { error: error.message });
    try {
      const fallbackResponse = await fallbackHandler(anime_id);
      const fallbackVideoUrl = fallbackResponse.sources.find(src => src.quality === quality)?.url;

      if (fallbackVideoUrl) {
        logger.info('[GET /] Serving fallback video URL', { fallbackVideoUrl });
        await setCache(cacheKey, fallbackVideoUrl);
        return res.render('index', { videoUrl: fallbackVideoUrl });
      } else {
        await delCache(cacheKey);
        logger.warn('[GET /] Requested quality not available in fallback sources', { quality });
        return res.status(404).render('error', { message: 'Requested quality not available in fallback sources' });
      }
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
