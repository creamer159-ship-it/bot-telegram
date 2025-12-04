import { CronTime } from 'cron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const DATA_DIR = path.resolve('data');
const JOBS_FILE_PATH = path.join(DATA_DIR, 'jobs.json');
const readPersistedJobs = async () => {
    try {
        const fileContent = await readFile(JOBS_FILE_PATH, 'utf-8');
        const parsed = JSON.parse(fileContent);
        if (!Array.isArray(parsed)) {
            throw new Error('data/jobs.json does not contain an array of jobs');
        }
        return parsed.map((job) => job);
    }
    catch (error) {
        const err = error;
        if (err?.code === 'ENOENT') {
            return [];
        }
        console.warn('Nie udało się wczytać jobs.json. Rozpoczynamy z pustą listą.', error);
        return [];
    }
};
const writePersistedJobs = async (jobs) => {
    try {
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(JOBS_FILE_PATH, JSON.stringify(jobs, null, 2), 'utf-8');
    }
    catch (error) {
        console.error('Nie udało się zapisać pliku data/jobs.json:', error);
    }
};
class JobStore {
    jobsByOwner = new Map();
    nextId = 1;
    constructor(initialJobs = []) {
        for (const job of initialJobs) {
            this.restoreJob(job);
        }
    }
    restoreJob(job) {
        const jobRecord = { ...job };
        const ownerJobs = this.jobsByOwner.get(jobRecord.ownerChatId) ?? new Map();
        ownerJobs.set(jobRecord.id, jobRecord);
        this.jobsByOwner.set(jobRecord.ownerChatId, ownerJobs);
        this.nextId = Math.max(this.nextId, jobRecord.id + 1);
    }
    getSerializedJobs() {
        const jobs = this.getAllJobs();
        return jobs.map((jobRecord) => {
            const { job: _job, ...data } = jobRecord;
            return {
                ...data,
                entities: data.entities ? data.entities.map((entity) => ({ ...entity })) : undefined,
            };
        });
    }
    persistState() {
        const snapshot = this.getSerializedJobs();
        void writePersistedJobs(snapshot);
    }
    addJob(params) {
        const jobRecord = {
            id: this.nextId++,
            ownerChatId: params.ownerChatId,
            targetChatId: params.targetChatId,
            cronExpr: params.cronExpr,
            contentType: params.contentType,
            text: params.text,
            fileId: params.fileId,
            entities: params.entities,
            scheduledAt: params.scheduledAt,
            repeat: params.repeat,
            type: params.type,
            job: params.job,
        };
        const ownerJobs = this.jobsByOwner.get(params.ownerChatId) ?? new Map();
        ownerJobs.set(jobRecord.id, jobRecord);
        this.jobsByOwner.set(params.ownerChatId, ownerJobs);
        this.persistState();
        return jobRecord;
    }
    getJobsForChat(ownerChatId) {
        const ownerJobs = this.jobsByOwner.get(ownerChatId);
        if (!ownerJobs) {
            return [];
        }
        return Array.from(ownerJobs.values()).sort((a, b) => a.id - b.id);
    }
    getJob(ownerChatId, jobId) {
        return this.jobsByOwner.get(ownerChatId)?.get(jobId);
    }
    updateJobText(ownerChatId, jobId, text) {
        const jobRecord = this.getJob(ownerChatId, jobId);
        if (!jobRecord) {
            return undefined;
        }
        jobRecord.text = text;
        jobRecord.entities = undefined;
        this.persistState();
        return jobRecord;
    }
    updateJobContent(jobId, updates) {
        const jobRecord = this.getJobById(jobId);
        if (!jobRecord) {
            return undefined;
        }
        if (updates.contentType) {
            jobRecord.contentType = updates.contentType;
        }
        if ('text' in updates) {
            jobRecord.text = updates.text;
        }
        if ('entities' in updates) {
            jobRecord.entities = updates.entities;
        }
        if ('fileId' in updates) {
            jobRecord.fileId = updates.fileId;
        }
        this.persistState();
        return jobRecord;
    }
    removeJob(ownerChatId, jobId) {
        const ownerJobs = this.jobsByOwner.get(ownerChatId);
        if (!ownerJobs) {
            return undefined;
        }
        const jobRecord = ownerJobs.get(jobId);
        if (!jobRecord) {
            return undefined;
        }
        if (jobRecord.job) {
            try {
                jobRecord.job.stop();
            }
            catch (error) {
                console.error(`Nie udało się zatrzymać zadania #${jobId}`, error);
            }
        }
        ownerJobs.delete(jobId);
        if (ownerJobs.size === 0) {
            this.jobsByOwner.delete(ownerChatId);
        }
        this.persistState();
        return jobRecord;
    }
    getAllJobs() {
        const result = [];
        for (const ownerJobs of this.jobsByOwner.values()) {
            result.push(...ownerJobs.values());
        }
        return result.sort((a, b) => a.id - b.id);
    }
    getJobById(jobId) {
        for (const ownerJobs of this.jobsByOwner.values()) {
            const jobRecord = ownerJobs.get(jobId);
            if (jobRecord) {
                return jobRecord;
            }
        }
        return undefined;
    }
    async updateCron(jobId, cronExpr, metadata = {}) {
        const jobRecord = this.getJobById(jobId);
        if (!jobRecord) {
            return undefined;
        }
        if (jobRecord.job) {
            try {
                await jobRecord.job.stop();
            }
            catch (error) {
                console.error(`Nie udało się zatrzymać zadania #${jobId} przed aktualizacją harmonogramu`, error);
            }
            try {
                jobRecord.job.setTime(new CronTime(cronExpr));
                jobRecord.job.start();
            }
            catch (error) {
                console.error(`Nie udało się ustawić nowego harmonogramu dla zadania #${jobId}`, error);
            }
        }
        jobRecord.cronExpr = cronExpr;
        if (metadata.scheduledAt !== undefined) {
            jobRecord.scheduledAt = metadata.scheduledAt;
        }
        if (metadata.repeat !== undefined) {
            jobRecord.repeat = metadata.repeat;
        }
        this.persistState();
        return jobRecord;
    }
}
const persistedJobs = await readPersistedJobs();
const jobStore = new JobStore(persistedJobs);
export default jobStore;
//# sourceMappingURL=jobStore.js.map