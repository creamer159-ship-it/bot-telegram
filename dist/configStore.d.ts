export declare const isProd: boolean;
export type BotConfig = {
    adminIds: number[];
    mainChannelId: number | null;
};
declare class ConfigStore {
    private config;
    private constructor();
    static initialize(): Promise<ConfigStore>;
    getConfig(): BotConfig;
    getAdminIds(): number[];
    isAdmin(id: number): boolean;
    addAdmin(id: number): boolean;
    ensureBootstrapAdmin(id: number): boolean;
    removeAdmin(id: number): boolean;
    getMainChannelId(): number | null;
    setMainChannelId(id: number | null): void;
    private persist;
    private static buildDefault;
    private static normalize;
}
declare const configStore: ConfigStore;
export default configStore;
//# sourceMappingURL=configStore.d.ts.map