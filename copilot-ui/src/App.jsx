import React from 'react';
import { CopilotKit } from '@copilotkit/react-core';
import { CopilotChat } from '@copilotkit/react-ui';
import '@copilotkit/react-ui/styles.css';

const SYSTEM_PROMPT = `You are an onboarding assistant for OpenClaw, a personal AI assistant platform.

Your job is to help the user set up OpenClaw by collecting the required configuration answers and then running the onboarding wizard.

Important:
- The user's LLM API key has already been configured securely. Do NOT ask for it.
- Ask the user for their preferences one at a time: model name, any other onboarding prompts.
- Once you have all the answers, call the run_onboarding tool with the answers as a newline-separated string.
- After onboarding completes, call exec_shell with "curl -s http://localhost:18789/health" to verify OpenClaw is running.
- When everything is confirmed working, tell the user setup is complete and call window.api.notifyOnboardingComplete() by informing them you're done.

Be friendly, concise, and guide non-technical users through each step.`;

function App() {
  const handleComplete = () => {
    if (window.api && window.api.notifyOnboardingComplete) {
      window.api.notifyOnboardingComplete();
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <CopilotKit runtimeUrl="http://localhost:18791/copilotkit">
        <CopilotChat
          instructions={SYSTEM_PROMPT}
          labels={{
            title: 'OpenClaw Assistant',
            initial: 'Hi! I\'ll help you set up OpenClaw. Let\'s get started!'
          }}
          makeSystemMessage={(msg) => msg}
        />
      </CopilotKit>
    </div>
  );
}

export default App;
