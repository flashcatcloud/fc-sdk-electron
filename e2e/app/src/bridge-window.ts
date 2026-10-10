import { flashcatRum } from '@flashcatcloud/browser-rum';

flashcatRum.init({
  applicationId: 'e2e-renderer-app-id',
  clientToken: 'pub-renderer-token',
  service: 'e2e-renderer',
  sessionSampleRate: 100,
  trackResources: true,
  trackLongTasks: true,
  trackUserInteractions: true,
  // Lets a scenario report an error that `beforeSend` drops, which must not count as the session's
  // error anywhere downstream.
  beforeSend: (event) => !(event.type === 'error' && event.error.message.includes('dropped-by-beforeSend')),
});

document.getElementById('status')!.textContent = 'bridge-ready';
