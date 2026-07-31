import { flashcatRum } from '@flashcatcloud/browser-rum';

flashcatRum.init({
  applicationId: 'e2e-renderer-app-id',
  clientToken: 'pub-renderer-token',
  service: 'e2e-renderer',
  sessionSampleRate: 100,
  trackResources: true,
  trackLongTasks: true,
  trackUserInteractions: true,
});

document.getElementById('status')!.textContent = 'bridge-ready';
