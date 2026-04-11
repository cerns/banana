import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import os from 'os';

const KEYS_PATH = path.join(os.homedir(), '.banana', 'vapid.json');
const SUBS_PATH = path.join(os.homedir(), '.banana', 'push-subscriptions.json');

class PushManager {
  private publicKey = '';
  private privateKey = '';
  private subscriptions: webpush.PushSubscription[] = [];

  init(): void {
    this.loadOrGenerateKeys();
    this.loadSubscriptions();
    webpush.setVapidDetails('mailto:banana@localhost', this.publicKey, this.privateKey);
    console.log('[push] VAPID ready. Subscriptions loaded:', this.subscriptions.length);
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  addSubscription(sub: webpush.PushSubscription): void {
    // Replace existing subscription for the same endpoint
    this.subscriptions = this.subscriptions.filter(s => s.endpoint !== sub.endpoint);
    this.subscriptions.push(sub);
    this.saveSubscriptions();
    console.log('[push] Subscription added. Total:', this.subscriptions.length);
  }

  async sendPush(title: string, body: string): Promise<void> {
    if (this.subscriptions.length === 0) return;
    const payload = JSON.stringify({ title, body });
    const expired: string[] = [];

    await Promise.allSettled(
      this.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
        } catch (err: unknown) {
          const e = err as { statusCode?: number };
          if (e.statusCode === 410 || e.statusCode === 404) {
            expired.push(sub.endpoint); // subscription gone
          } else {
            console.error('[push] send error:', err);
          }
        }
      })
    );

    if (expired.length > 0) {
      this.subscriptions = this.subscriptions.filter(s => !expired.includes(s.endpoint));
      this.saveSubscriptions();
    }
  }

  private loadOrGenerateKeys(): void {
    try {
      const data = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')) as { publicKey: string; privateKey: string };
      this.publicKey = data.publicKey;
      this.privateKey = data.privateKey;
    } catch {
      const keys = webpush.generateVAPIDKeys();
      this.publicKey = keys.publicKey;
      this.privateKey = keys.privateKey;
      fs.mkdirSync(path.dirname(KEYS_PATH), { recursive: true });
      fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
      console.log('[push] Generated new VAPID keys →', KEYS_PATH);
    }
  }

  private loadSubscriptions(): void {
    try {
      this.subscriptions = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8'));
    } catch {
      this.subscriptions = [];
    }
  }

  private saveSubscriptions(): void {
    try {
      fs.mkdirSync(path.dirname(SUBS_PATH), { recursive: true });
      fs.writeFileSync(SUBS_PATH, JSON.stringify(this.subscriptions, null, 2));
    } catch (e) {
      console.error('[push] save subscriptions error:', e);
    }
  }
}

export const pushManager = new PushManager();
