import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
class ConfigStore {
    config;
    constructor(config) {
        this.config = config;
    }
    static async initialize() {
        await mkdir(DATA_DIR, { recursive: true });
        try {
            const rawContent = await readFile(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(rawContent);
            const normalized = ConfigStore.normalize(parsed);
            return new ConfigStore(normalized);
        }
        catch (error) {
            if (error?.code === 'ENOENT') {
                const fallback = ConfigStore.buildDefault();
                const store = new ConfigStore(fallback);
                await store.persist();
                return store;
            }
            throw error;
        }
    }
    getConfig() {
        return {
            adminIds: [...this.config.adminIds],
            mainChannelId: this.config.mainChannelId,
        };
    }
    getAdminIds() {
        return [...this.config.adminIds];
    }
    isAdmin(id) {
        return this.config.adminIds.includes(id);
    }
    addAdmin(id) {
        if (this.isAdmin(id)) {
            return false;
        }
        this.config.adminIds.push(id);
        void this.persist();
        return true;
    }
    removeAdmin(id) {
        if (!this.isAdmin(id)) {
            return false;
        }
        this.config.adminIds = this.config.adminIds.filter((storedId) => storedId !== id);
        void this.persist();
        return true;
    }
    getMainChannelId() {
        return this.config.mainChannelId;
    }
    setMainChannelId(id) {
        if (this.config.mainChannelId === id) {
            return;
        }
        this.config.mainChannelId = id;
        void this.persist();
    }
    async persist() {
        const payload = JSON.stringify(this.config, null, 2);
        try {
            await writeFile(CONFIG_PATH, payload, 'utf8');
        }
        catch (error) {
            console.error('Nie udało się zapisać konfiguracji bota:', error);
        }
    }
    static buildDefault() {
        const adminIds = (process.env.ADMIN_IDS ?? '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
            .map((value) => Number(value))
            .filter((value) => !Number.isNaN(value));
        const channelEnv = typeof process.env.CHANNEL_ID === 'string' ? process.env.CHANNEL_ID.trim() : '';
        const mainChannelId = channelEnv.length === 0
            ? null
            : (() => {
                const parsed = Number(channelEnv);
                return Number.isNaN(parsed) ? null : parsed;
            })();
        return {
            adminIds: Array.from(new Set(adminIds)),
            mainChannelId,
        };
    }
    static normalize(value) {
        const defaultConfig = ConfigStore.buildDefault();
        if (typeof value !== 'object' || value === null) {
            return defaultConfig;
        }
        const raw = value;
        const adminIds = Array.isArray(raw.adminIds) && raw.adminIds.length > 0
            ? Array.from(new Set(raw.adminIds
                .map((item) => Number(item))
                .filter((num) => !Number.isNaN(num))))
            : defaultConfig.adminIds;
        const mainChannelId = raw.mainChannelId === null
            ? null
            : typeof raw.mainChannelId === 'number' && !Number.isNaN(raw.mainChannelId)
                ? raw.mainChannelId
                : defaultConfig.mainChannelId;
        return {
            adminIds,
            mainChannelId,
        };
    }
}
const configStore = await ConfigStore.initialize();
export default configStore;
//# sourceMappingURL=configStore.js.map