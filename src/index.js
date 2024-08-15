import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import GogoCDN from './lib/gogocdn.js';
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

// Middleware setup
app.use(cors(
  {
    origin: '*',
  }
));
app.use(bodyParser.json());
app.use(morgan('dev'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter);

// Serve robots.txt
app.use('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send("User-agent: *\nDisallow: /");
});

// Setup EJS for rendering views
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, './views'));

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'anime-streaming-api' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  ],
});

// Define available servers (only gogo is kept)
const servers = {
  gogocdn: new GogoCDN(),
};

// Fallback handler for alternative server
async function fallbackHandler(anime_id) {
  const response = await axios.get(`${process.env.CONSUMET_API}/anime/gogoanime/watch/${anime_id}`);
  return response.data;
}

// Main route for serving anime streams
app.get('/', async (req, res) => {
  const { anime_id, server } = req.query;

  if (!anime_id || !server) {
    logger.error('Missing required parameters', { anime_id, server });
    return res.status(400).render('error', { message: 'Missing required parameters' });
  }

  if (!servers[server]) {
    logger.error('Invalid server', { server });
    return res.status(400).render('error', { message: 'Invalid server' });
  }

  const ep_id = anime_id;
  const cacheKey = `${server}-${ep_id}`;  // Ensure cacheKey is defined outside the try block

  try {
    const cachedData = await getCache(cacheKey);

    if (cachedData) {
      const { videoUrl, qualities } = JSON.parse(cachedData);
      logger.info('Serving video from cache', { videoUrl });
      return res.render('index', { videoUrl, qualities });
    }

    const sources = await servers[server].getEpisodeSources(ep_id);
    if (!sources || sources.length === 0) {
      logger.warn('No sources available');
      return res.status(404).render('error', { message: 'No sources available' });
    }

    const qualities = sources.map(source => ({
      quality: source.quality,
      url: `https://node-proxy.5yg3y1.easypanel.host/proxy/m3u8?url=${source.url}`
    }));

    const backupIndex = qualities.findIndex(q => q.quality === 'backup' || q.quality === 'default');
    if (backupIndex > -1) qualities.splice(backupIndex, 1);

    const videoUrl = qualities[0].url;
    logger.info('Streaming video', { videoUrl, server, anime_id });

    const cacheData = JSON.stringify({ videoUrl, qualities });
    await setCache(cacheKey, cacheData);
    res.render('index', { videoUrl, qualities });

  } catch (error) {
    logger.error('Error getting video URL from primary server', { error: error.message });

    try {
      const fallbackResponse = await fallbackHandler(anime_id);
      const fallbackSources = fallbackResponse.sources;

      if (!fallbackSources || fallbackSources.length === 0) {
        await delCache(cacheKey);  // `cacheKey` is now defined correctly
        logger.warn('No fallback sources available');
        return res.status(404).render('error', { message: 'No fallback sources available' });
      }

      const qualities = fallbackSources.map(source => ({
        quality: source.quality,
        url: `https://node-proxy.5yg3y1.easypanel.host/proxy/m3u8?url=${source.url}`
      }));

      const fallbackVideoUrl = qualities[0].url;
      logger.info('Serving fallback video URL', { fallbackVideoUrl });

      const cacheData = JSON.stringify({ videoUrl: fallbackVideoUrl, qualities });
      await setCache(cacheKey, cacheData);
      return res.render('index', { videoUrl: fallbackVideoUrl, qualities });

    } catch (fallbackError) {
      logger.error('Error getting video URL from fallback server', { fallbackError: fallbackError.message });
      res.status(500).render('error', { message: 'Failed to get video URL from both primary and fallback servers' });
    }
  }
});


// Route to get sources for an anime episode
app.get('/sources', async (req, res) => {
  const { anime_id } = req.query;

  if (!anime_id) {
    logger.error('Missing required parameters', { anime_id });
    return res.status(400).render('error', { message: 'Missing required parameters' });
  }

  const ep_id = anime_id;
  const cacheKey = `sources-${ep_id}`;
  const cachedData = await getCache(cacheKey);

  if (cachedData) {
    logger.info('Serving sources from cache', { ep_id });
    return res.json(JSON.parse(cachedData));
  }

  const results = {};
  const serverPromises = Object.keys(servers).map(async server => {
    try {
      const sources = await servers[server].getEpisodeSources(ep_id);
      results[server] = sources.length ? sources : { error: 'No sources found' };
    } catch (error) {
      logger.error(`Error getting sources from ${server}`, { error: error.message });
      results[server] = { error: 'Failed to get sources' };
    }
  });

  await Promise.all(serverPromises);

  const hasErrors = Object.values(results).some(result => result.error);
  if (!hasErrors) await setCache(cacheKey, JSON.stringify(results));

  logger.info('Fetched sources', { anime_id });
  res.json(results);
});

// Start the server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});
