import { CronTime } from 'cron';
import type { CronJob } from 'cron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

const DATA_DIR = path.resolve('data');
const JOBS_FILE_PATH = path.join(DATA_DIR, 'jobs.json');

const readPersistedJobs = async (): Promise<ScheduledJobData[]> => {
  try {
    const fileContent = await readFile(JOBS_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(fileContent);
    if (!Array.isArray(parsed)) {
      throw new Error('data/jobs.json does not contain an array of jobs');
    }
    return parsed.map((job) => job as ScheduledJobData);
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err?.code === 'ENOENT') {
      return [];
    }
    console.warn('Nie udało się wczytać jobs.json. Rozpoczynamy z pustą listą.', error);
    return [];
  }
};

const writePersistedJobs = async (jobs: ScheduledJobData[]) => {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(JOBS_FILE_PATH, JSON.stringify(jobs, null, 2), 'utf-8');
  } catch (error) {
    console.error('Nie udało się zapisać pliku data/jobs.json:', error);
  }
};

class JobStore {
  private readonly jobsByOwner = new Map<number, Map<number, ScheduledJob>>();
  private nextId = 1;

  constructor(initialJobs: ScheduledJobData[] = []) {
    for (const job of initialJobs) {
      this.restoreJob(job);
    }
  }

  private restoreJob(job: ScheduledJobData) {
    const jobRecord: ScheduledJob = { ...job };
    const ownerJobs = this.jobsByOwner.get(jobRecord.ownerChatId) ?? new Map<number, ScheduledJob>();
    ownerJobs.set(jobRecord.id, jobRecord);
    this.jobsByOwner.set(jobRecord.ownerChatId, ownerJobs);
    this.nextId = Math.max(this.nextId, jobRecord.id + 1);
  }

  getSerializedJobs(): ScheduledJobData[] {
    const jobs = this.getAllJobs();
    return jobs.map((jobRecord) => {
      const { job: _job, ...data } = jobRecord;
      return {
        ...data,
        entities: data.entities ? data.entities.map((entity) => ({ ...entity })) : undefined,
      };
    });
  }

  private persistState() {
    const snapshot = this.getSerializedJobs();
    void writePersistedJobs(snapshot);
  }

  addJob(params: AddJobParams): ScheduledJob {
    const jobRecord: ScheduledJob = {
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
    const ownerJobs = this.jobsByOwner.get(params.ownerChatId) ?? new Map<number, ScheduledJob>();
    ownerJobs.set(jobRecord.id, jobRecord);
    this.jobsByOwner.set(params.ownerChatId, ownerJobs);
    this.persistState();
    return jobRecord;
  }

  getJobsForChat(ownerChatId: number): ScheduledJob[] {
    const ownerJobs = this.jobsByOwner.get(ownerChatId);
    if (!ownerJobs) {
      return [];
    }
    return Array.from(ownerJobs.values()).sort((a, b) => a.id - b.id);
  }

  getJob(ownerChatId: number, jobId: number): ScheduledJob | undefined {
    return this.jobsByOwner.get(ownerChatId)?.get(jobId);
  }

  updateJobText(ownerChatId: number, jobId: number, text: string): ScheduledJob | undefined {
    const jobRecord = this.getJob(ownerChatId, jobId);
    if (!jobRecord) {
      return undefined;
    }
    jobRecord.text = text;
    jobRecord.entities = undefined;
    this.persistState();
    return jobRecord;
  }

  updateJobContent(
    jobId: number,
    updates: {
      contentType?: JobContentType;
      text?: string | undefined;
      entities?: MessageEntity[] | undefined;
      fileId?: string | undefined;
    },
  ): ScheduledJob | undefined {
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

  removeJob(ownerChatId: number, jobId: number): ScheduledJob | undefined {
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
      } catch (error) {
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

  getAllJobs(): ScheduledJob[] {
    const result: ScheduledJob[] = [];
    for (const ownerJobs of this.jobsByOwner.values()) {
      result.push(...ownerJobs.values());
    }
    return result.sort((a, b) => a.id - b.id);
  }

  getJobById(jobId: number): ScheduledJob | undefined {
    for (const ownerJobs of this.jobsByOwner.values()) {
      const jobRecord = ownerJobs.get(jobId);
      if (jobRecord) {
        return jobRecord;
      }
    }
    return undefined;
  }

  async updateCron(
    jobId: number,
    cronExpr: string,
    metadata: { scheduledAt?: string; repeat?: RepeatMode } = {},
  ): Promise<ScheduledJob | undefined> {
    const jobRecord = this.getJobById(jobId);
    if (!jobRecord) {
      return undefined;
    }
    if (jobRecord.job) {
      try {
        await jobRecord.job.stop();
      } catch (error) {
        console.error(`Nie udało się zatrzymać zadania #${jobId} przed aktualizacją harmonogramu`, error);
      }
      try {
        jobRecord.job.setTime(new CronTime(cronExpr));
        jobRecord.job.start();
      } catch (error) {
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
