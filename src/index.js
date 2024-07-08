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

app.get('/', (req, res) => {
    // ?anime_id=one-piece&episode=1&quality=360p&server=gogcdn
    const { anime_id, episode, quality, server } = req.query;
    if (!anime_id || !episode || !quality || !server) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    if (!servers[server]) {
        return res.status(400).json({ error: 'Invalid server' });
    }

    let ep_id = anime_id + '-episode-' + episode;
    servers[server].getEpisodeSources(ep_id)
        .then(sources => {
        const source = sources.find(source => source.quality === quality);
        if (!source) {
            const availableQualities = sources.map(source => source.quality);
            return res.status(404).json({ error: 'Requested quality not available', availableQualities });
        }
        res.json(source);
        })
        .catch(error => {
            console.error('Error getting episode sources:', error);
            res.status(500).json({ error: 'Internal server error' });
        });
});

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});