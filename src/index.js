import express from 'express';
import bodyParser from 'body-parser';
import GogoCDN from './lib/gogocdn.js';
import StreamWish from './lib/streamWish.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors'; 
import { setCache, getCache } from './utils/redis.js';

dotenv.config();

const app = express();
app.use(cors(
    // allow all origins
    {
        origin: '*'
    }
));
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, './views'));

const servers = {
    gogocdn: new GogoCDN(),
    streamwish: new StreamWish(),
    // Add other servers here
};

app.get('/', async (req, res) => {
    const { anime_id, episode, quality, server } = req.query;

    if (!anime_id || !episode || !quality || !server) {
        return res.status(400).render('error', { message: 'Missing required parameters' });
    }

    if (!servers[server]) {
        return res.status(400).render('error', { message: 'Invalid server' });
    }

    try {
        const ep_id = episode === '0' ? `${anime_id}` : `${anime_id}-episode-${episode}`;

        // Check cache
        const cacheKey = `${server}-${ep_id}-${quality}`;
        const cachedVideoUrl = await getCache(cacheKey);

        if (cachedVideoUrl) {
            console.log(`Serving ${cachedVideoUrl} from cache`);
            return res.render('index', { videoUrl: cachedVideoUrl });
        }

        const sources = await servers[server].getEpisodeSources(ep_id);
        const source = sources.find(src => src.quality === quality);

        if (!source) {
            const availableQualities = sources.map(src => src.quality);
            return res.status(404).render('error', { message: 'Requested quality not available', availableQualities });
        }

        let videoUrl = source.url;
        console.log(`Streaming ${videoUrl} from ${server}`);
        // log all
        console.log(`Anime ID: ${anime_id}, Episode: ${episode}, Quality: ${quality}, Server: ${server}, Url: http://localhost:4000/?anime_id=${anime_id}&episode=${episode}&quality=${quality}&server=${server}`);
        // Cache the video URL
        await setCache(cacheKey, videoUrl);
        res.render('index', { videoUrl });
    } catch (error) {
        console.error(`Error getting episode sources from ${server}:`, error);
        res.status(500).render('error', { message: 'Internal server error' });
    }
});

// Route to get sources
app.get('/sources', async (req, res) => {
    const { anime_id, episode } = req.query;

    if (!anime_id || !episode) {
        return res.status(400).render('error', { message: 'Missing required parameters' });
    }

    const ep_id = episode === '0' ? `${anime_id}` : `${anime_id}-episode-${episode}`;
    const results = {};

    const serverPromises = Object.keys(servers).map(async server => {
        try {
            const sources = await servers[server].getEpisodeSources(ep_id);
            results[server] = sources.length ? sources : { error: 'No sources found' };
        } catch (error) {
            console.error(`Error getting episode sources from ${server}:`, error);
            results[server] = { error: 'Failed to retrieve sources' };
        }
    });

    await Promise.all(serverPromises);

    console.log(`Url: http://localhost:4000/sources?anime_id=${anime_id}&episode=${episode}`);
    res.json(results);
});

// Start the server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
