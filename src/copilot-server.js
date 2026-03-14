// CopilotKit runtime server — runs inside the VM on port 18791
// Transferred to the VM during first-boot setup via HTTP
const express = require('express');
const { CopilotRuntime, OpenAIAdapter } = require('@copilotkit/runtime');
const fs = require('fs');
const { execSync } = require('child_process');

const CREDS_PATH = '/home/node/.config/openclaw/credentials.json';

// Read credentials stored by the host during setup
let credentials;
try {
  credentials = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
} catch (err) {
  console.error('Failed to read credentials:', err.message);
  process.exit(1);
}

const adapter = new OpenAIAdapter({
  openaiApiKey: credentials.apiKey,
  openaiBaseUrl: credentials.baseUrl
});

const runtime = new CopilotRuntime({
  actions: [
    {
      name: 'run_onboarding',
      description: 'Run the OpenClaw onboarding wizard with the collected answers. Pass answers as a newline-separated string.',
      parameters: [
        {
          name: 'answers',
          type: 'string',
          description: 'Newline-separated answers for the onboarding prompts'
        }
      ],
      handler: async ({ answers }) => {
        try {
          const cmd = `printf '${answers.replace(/'/g, "'\\''")}' | node dist/index.js onboard 2>&1`;
          const output = execSync(cmd, { cwd: '/app', timeout: 120000, encoding: 'utf8' });
          return output;
        } catch (err) {
          return `Error: ${err.message}\n${err.stdout || ''}${err.stderr || ''}`;
        }
      }
    },
    {
      name: 'exec_shell',
      description: 'Execute a shell command inside the VM and return stdout+stderr.',
      parameters: [
        {
          name: 'command',
          type: 'string',
          description: 'The shell command to execute'
        }
      ],
      handler: async ({ command }) => {
        try {
          const output = execSync(command, { timeout: 30000, encoding: 'utf8' });
          return output;
        } catch (err) {
          return `Error (exit ${err.status}): ${err.stdout || ''}${err.stderr || ''}`;
        }
      }
    }
  ]
});

const app = express();

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/copilotkit', runtime.handler({ adapter }));

app.listen(18791, '0.0.0.0', () => {
  console.log('COPILOTKIT_STARTED');
});
