#!/usr/bin/env node
import { parseArgs } from 'util';
import { listCommand } from './commands/list.js';
import { sendCommand } from './commands/send.js';
import { logsCommand } from './commands/logs.js';
import { killCommand } from './commands/kill.js';
import { stopCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { machinesListCommand, machinesAddCommand, machinesRemoveCommand, machinesTestCommand, machinesDetectCommand, machinesSetupCommand, machinesCrontabCommand } from './commands/machines.js';
import { hubChannelsCommand, hubPostCommand, hubMessagesCommand } from './commands/hub.js';
import {
  tasksListCommand, tasksShowCommand, tasksCreateCommand,
  tasksUpdateCommand, tasksCommentCommand, tasksRemoveCommand,
} from './commands/tasks.js';
import {
  docsListCommand, docsShowCommand, docsCreateCommand,
  docsUpdateCommand, docsAppendCommand, docsHistoryCommand, docsRemoveCommand,
} from './commands/docs.js';

const USAGE = `
Usage: banana <command> [args]

Commands:
  list                          List all sessions
  send <session> <prompt>       Send a prompt to a session
  logs <session>                Show job history for a session
  stop <session>                Stop the running job (like ESC)
  kill <session>                Force disconnect a session
  status                        Show server health
  machines                      List machines
  machines add                  Add a machine interactively
  machines rm <id>              Remove a machine
  machines test <id>            Test SSH connection
  machines detect <id>          Detect runtimes on a machine
  machines setup <id>           Install bun + claude on a machine
  machines crontab <id>         Show crontab entries for a machine
  hub channels                  List hub channels
  hub post <channel> <msg>      Post message (--tags=x,y)
  hub messages <channel>        View channel messages

  tasks list <channel>          List tasks (--status= --q= --tags= --assignee=)
  tasks show <id>               Show a task with activity log
  tasks create <channel>        Create task (--title= --assignee= --tags= --priority=)
  tasks update <id>             Update task (--status= --assignee= --title= ...)
  tasks comment <id> "<text>"   Add comment
  tasks rm <id>                 Remove task

  docs list <channel>           List docs (--q= --tags=)
  docs show <id>                Show a doc body
  docs create <channel>         Create doc (--title= --file=path [--tags=])
  docs update <id>              Update doc (--title= --file= [--tags=])
  docs append <id>              Append text (--file= or --body=)
  docs history <id>             Show prior revisions
  docs rm <id>                  Remove doc

Options:
  --help, -h                    Show this help

Environment:
  BANANA_TOKEN     (required) Shared secret
  BANANA_SERVER_URL            Server URL (default: http://localhost:3000)
`.trim();

const { positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
});

// Show help if requested or no command
if (
  process.argv.includes('--help') ||
  process.argv.includes('-h') ||
  positionals.length === 0
) {
  console.log(USAGE);
  process.exit(0);
}

const [command, ...rest] = positionals;

async function main(): Promise<void> {
  switch (command) {
    case 'list':
      await listCommand();
      break;

    case 'send': {
      const [session, ...promptParts] = rest;
      await sendCommand(session, promptParts.join(' '));
      break;
    }

    case 'logs':
      await logsCommand(rest[0]);
      break;

    case 'stop':
      await stopCommand(rest[0]);
      break;

    case 'kill':
      await killCommand(rest[0]);
      break;

    case 'status':
      await statusCommand();
      break;

    case 'machines': {
      const sub = rest[0];
      if (sub === 'add') {
        await machinesAddCommand();
      } else if (sub === 'rm') {
        await machinesRemoveCommand(rest[1]);
      } else if (sub === 'test') {
        await machinesTestCommand(rest[1]);
      } else if (sub === 'detect') {
        await machinesDetectCommand(rest[1]);
      } else if (sub === 'setup') {
        await machinesSetupCommand(rest[1]);
      } else if (sub === 'crontab') {
        await machinesCrontabCommand(rest[1]);
      } else {
        await machinesListCommand();
      }
      break;
    }

    case 'hub': {
      const sub = rest[0];
      if (sub === 'post') {
        const tagsFlag = process.argv.find(a => a.startsWith('--tags='));
        const tags = tagsFlag ? tagsFlag.split('=')[1] : undefined;
        await hubPostCommand(rest[1], rest.slice(2).join(' '), tags);
      } else if (sub === 'messages') {
        await hubMessagesCommand(rest[1]);
      } else {
        await hubChannelsCommand();
      }
      break;
    }

    case 'tasks': {
      const sub = rest[0];
      if (sub === 'list') {
        await tasksListCommand(rest[1]);
      } else if (sub === 'show') {
        await tasksShowCommand(rest[1]);
      } else if (sub === 'create') {
        await tasksCreateCommand(rest[1]);
      } else if (sub === 'update') {
        await tasksUpdateCommand(rest[1]);
      } else if (sub === 'comment') {
        await tasksCommentCommand(rest[1], rest.slice(2).join(' '));
      } else if (sub === 'rm') {
        await tasksRemoveCommand(rest[1]);
      } else {
        console.error('Usage: banana tasks <list|show|create|update|comment|rm> ...');
        process.exit(1);
      }
      break;
    }

    case 'docs': {
      const sub = rest[0];
      if (sub === 'list') {
        await docsListCommand(rest[1]);
      } else if (sub === 'show') {
        await docsShowCommand(rest[1]);
      } else if (sub === 'create') {
        await docsCreateCommand(rest[1]);
      } else if (sub === 'update') {
        await docsUpdateCommand(rest[1]);
      } else if (sub === 'append') {
        await docsAppendCommand(rest[1]);
      } else if (sub === 'history') {
        await docsHistoryCommand(rest[1]);
      } else if (sub === 'rm') {
        await docsRemoveCommand(rest[1]);
      } else {
        console.error('Usage: banana docs <list|show|create|update|append|history|rm> ...');
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
