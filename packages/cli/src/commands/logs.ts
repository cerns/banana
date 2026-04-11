import { apiFetch } from '../client.js';

interface JobRecord {
  jobId: string;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  durationMs?: number;
  chunks: unknown[];
  error?: string;
}

interface SessionDetail {
  sessionId: string;
  hostname: string;
  workdir: string;
  status: string;
  jobs: JobRecord[];
}

export async function logsCommand(sessionPrefix: string): Promise<void> {
  if (!sessionPrefix) {
    console.error('Usage: banana logs <session-id-prefix>');
    process.exit(1);
  }

  const session = await apiFetch<SessionDetail>(`/api/sessions/${sessionPrefix}`);
  const { jobs } = session;

  if (!jobs || jobs.length === 0) {
    console.log('No jobs recorded for this session.');
    return;
  }

  for (const job of jobs) {
    console.log(`\n── Job ${job.jobId.slice(0, 8)} ──────────────────────────────`);
    console.log(`  Prompt   : ${job.prompt}`);
    console.log(`  Started  : ${job.startedAt}`);
    if (job.finishedAt) console.log(`  Finished : ${job.finishedAt}`);
    if (job.exitCode !== undefined) console.log(`  Exit code: ${job.exitCode}`);
    if (job.durationMs) console.log(`  Duration : ${job.durationMs}ms`);
    if (job.error) console.log(`  Error    : ${job.error}`);
    console.log(`  Chunks   : ${job.chunks.length}`);

    // Print text output from chunks
    for (const chunk of job.chunks) {
      const c = chunk as Record<string, unknown>;
      if (c.type === 'assistant') {
        const content = (c.message as Record<string, unknown>)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'text') process.stdout.write(String(b.text));
          }
        }
      }
      if (c.type === 'result') {
        process.stdout.write(String(c.result ?? ''));
      }
    }
    console.log('');
  }
}
