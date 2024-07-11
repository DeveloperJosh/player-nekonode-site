import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import GogoCDN from './lib/gogocdn.js';
import StreamWish from './lib/streamWish.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';
import { setCache, getCache, delCache } from './utils/redis.js';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import winston from 'winston';

dotenv.config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use('/robots.txt', function (req, res, next) {
    res.type('text/plain')
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
    const { anime_id, episode, quality, server } = req.query;

    if (!anime_id || !episode || !quality || !server) {
        logger.error('Missing required parameters');
        return res.status(400).render('error', { message: 'Missing required parameters' });
    }

    if (!servers[server]) {
        logger.error('Invalid server');
        return res.status(400).render('error', { message: 'Invalid server' });
    }

    try {
        const ep_id = episode === '0' ? `${anime_id}` : `${anime_id}-episode-${episode}`;
        const cacheKey = `${server}-${ep_id}-${quality}`;
        const cachedVideoUrl = await getCache(cacheKey);

        if (cachedVideoUrl) {
            logger.info(`Serving ${cachedVideoUrl} from cache`);
            return res.render('index', { videoUrl: cachedVideoUrl });
        }

        const sources = await servers[server].getEpisodeSources(ep_id);
        const source = sources.find(src => src.quality === quality);

        if (!source) {
            const availableQualities = sources.map(src => src.quality);
            return res.status(404).render('error', { message: 'Requested quality not available', availableQualities });
        }

        let videoUrl = source.url;
        logger.info(`Streaming ${videoUrl} from ${server}`);
        logger.info(`Anime ID: ${anime_id}, Episode: ${episode}, Quality: ${quality}, Server: ${server}, Url: anime_id=${anime_id}&episode=${episode}&quality=${quality}&server=${server}`);

        await setCache(cacheKey, videoUrl);
        res.render('index', { videoUrl });
    } catch (error) {
        logger.error('Error getting video URL from primary server:', error);
        try {
            const fallbackResponse = await fallbackHandler(anime_id);
            const fallbackVideoUrl = fallbackResponse.sources.find(src => src.quality === quality)?.url;

            if (fallbackVideoUrl) {
                logger.info(`Serving fallback video URL ${fallbackVideoUrl}`);
                await setCache(cacheKey, fallbackVideoUrl);
                return res.render('index', { videoUrl: fallbackVideoUrl });
            } else {
                await delCache(cacheKey);
                return res.status(404).render('error', { message: 'Requested quality not available in fallback sources' });
            }
        } catch (fallbackError) {
            logger.error('Error getting video URL from fallback server:', fallbackError);
            res.status(500).render('error', { message: 'Failed to get video URL from both primary and fallback servers' });
        }
    }
});

app.get('/sources', async (req, res) => {
    const { anime_id, episode } = req.query;

    if (!anime_id || !episode) {
        logger.error('Missing required parameters');
        return res.status(400).render('error', { message: 'Missing required parameters' });
    }

    const ep_id = episode === '0' ? `${anime_id}` : `${anime_id}-episode-${episode}`;
    const cacheKey = `sources-${ep_id}`;

    if (await getCache(cacheKey)) {
        logger.info(`Serving sources for ${ep_id} from cache`);
        return res.json(await getCache(cacheKey));
    }

    const results = {};
    const serverPromises = Object.keys(servers).map(async server => {
        try {
            const sources = await servers[server].getEpisodeSources(ep_id);
            results[server] = sources.length ? sources : { error: 'No sources found' };
        } catch (error) {
            logger.error(`Error getting sources from ${server}:`, error);
            results[server] = { error: 'Failed to get sources' };
        }
    });

    await Promise.all(serverPromises);

    logger.info(`Url: sources?anime_id=${anime_id}&episode=${episode}`);
    await setCache(cacheKey, results);
    res.json(results);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
});
