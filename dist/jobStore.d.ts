import type { CronJob } from 'cron';
import type { MessageEntity } from 'telegraf/types';
export type JobContentType = 'text' | 'photo' | 'video' | 'animation';
export type RepeatMode = 'none' | 'daily' | 'weekly' | 'monthly';
export type ScheduledJobType = 'post' | 'cron';
export interface ScheduledJobData {
    id: number;
    ownerChatId: number;
    targetChatId: number;
    cronExpr: string;
    contentType: JobContentType;
    text?: string | undefined;
    fileId?: string | undefined;
    entities?: MessageEntity[] | undefined;
    scheduledAt?: string | undefined;
    repeat?: RepeatMode | undefined;
    type?: ScheduledJobType | undefined;
}
export interface ScheduledJob extends ScheduledJobData {
    job?: CronJob;
}
interface AddJobParams extends Omit<ScheduledJobData, 'id'> {
    job: CronJob;
}
declare class JobStore {
    private readonly jobsByOwner;
    private nextId;
    constructor(initialJobs?: ScheduledJobData[]);
    private restoreJob;
    getSerializedJobs(): ScheduledJobData[];
    private persistState;
    addJob(params: AddJobParams): ScheduledJob;
    getJobsForChat(ownerChatId: number): ScheduledJob[];
    getJob(ownerChatId: number, jobId: number): ScheduledJob | undefined;
    updateJobText(ownerChatId: number, jobId: number, text: string): ScheduledJob | undefined;
    updateJobContent(jobId: number, updates: {
        contentType?: JobContentType;
        text?: string | undefined;
        entities?: MessageEntity[] | undefined;
        fileId?: string | undefined;
    }): ScheduledJob | undefined;
    removeJob(ownerChatId: number, jobId: number): ScheduledJob | undefined;
    getAllJobs(): ScheduledJob[];
    getJobById(jobId: number): ScheduledJob | undefined;
    updateCron(jobId: number, cronExpr: string, metadata?: {
        scheduledAt?: string;
        repeat?: RepeatMode;
    }): Promise<ScheduledJob | undefined>;
}
declare const jobStore: JobStore;
export default jobStore;
//# sourceMappingURL=jobStore.d.ts.map