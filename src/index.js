import express from 'express';
import bodyParser from 'body-parser';
import GogoCDN from './lib/gogocdn.js';
import StreamWish from './lib/streamWish.js';

const app = express();
app.use(bodyParser.json());

const servers = {
    gogocdn: new GogoCDN(),
    streamwish: new StreamWish(),
    // Add other servers here
};

app.get('/', async (req, res) => {
    const { anime_id, episode, quality, server } = req.query;

    if (!anime_id || !episode || !quality || !server) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    if (!servers[server]) {
        return res.status(400).json({ error: 'Invalid server' });
    }

    try {
        const ep_id = episode === '0' ? `${anime_id}` : `${anime_id}-episode-${episode}`;
        const sources = await servers[server].getEpisodeSources(ep_id);
        const source = sources.find(src => src.quality === quality);

        if (!source) {
            const availableQualities = sources.map(src => src.quality);
            return res.status(404).json({ error: 'Requested quality not available', availableQualities });
        }

        res.json(source);
    } catch (error) {
        console.error(`Error getting episode sources from ${server}:`, error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/sources', async (req, res) => {
    const { anime_id, episode } = req.query;

    if (!anime_id || !episode) {
        return res.status(400).json({ error: 'Missing required parameters' });
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

    res.json(results);
});

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
