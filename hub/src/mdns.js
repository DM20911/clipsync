// mDNS / Bonjour announcement for the hub.
import { Bonjour } from 'bonjour-service';

export function announceService({ port, name, txt = {} }) {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name,
    type: 'clipsync',
    protocol: 'tcp',
    port,
    txt,
  });
  return {
    stop: () => new Promise((resolve) => {
      service.stop(() => {
        bonjour.destroy();
        resolve();
      });
    }),
  };
}
