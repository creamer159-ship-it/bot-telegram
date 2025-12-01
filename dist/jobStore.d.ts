import type { CronJob } from 'cron';
import type { MessageEntity } from 'telegraf/types';
export type JobContentType = 'text' | 'photo' | 'video' | 'animation';
export interface ScheduledJobData {
    id: number;
    ownerChatId: number;
    targetChatId: number;
    cronExpr: string;
    contentType: JobContentType;
    text?: string | undefined;
    fileId?: string | undefined;
    entities?: MessageEntity[] | undefined;
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
    removeJob(ownerChatId: number, jobId: number): ScheduledJob | undefined;
    getAllJobs(): ScheduledJob[];
    getJobById(jobId: number): ScheduledJob | undefined;
    updateCron(jobId: number, cronExpr: string): Promise<ScheduledJob | undefined>;
}
declare const jobStore: JobStore;
export default jobStore;
//# sourceMappingURL=jobStore.d.ts.map