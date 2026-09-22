/**
 * IndexedDB Local Storage Manager for iPad Player
 * Stores high-definition video files persistently on iPad.
 */

const DB_NAME = 'iPadSyncPlayerDB';
const DB_VERSION = 1;
const STORE_NAME = 'videos';

class VideoDB {
  constructor() {
    this.db = null;
    this.initPromise = this._openDatabase();
  }

  _openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'deviceId' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  async ready() {
    if (!this.db) {
      await this.initPromise;
    }
    return this.db;
  }

  /**
   * Save a selected video File/Blob to IndexedDB
   * @param {number|string} deviceId 
   * @param {File|Blob} file 
   * @param {number} duration 
   * @returns {Promise<Object>}
   */
  async saveVideo(deviceId, file, duration = 0) {
    const db = await this.ready();
    const idKey = Number(deviceId);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const record = {
        deviceId: idKey,
        name: file.name || `video_slot_${idKey}.mp4`,
        type: file.type || 'video/mp4',
        size: file.size,
        duration: duration,
        lastModified: file.lastModified || Date.now(),
        blob: file
      };

      const request = store.put(record);

      request.onsuccess = () => {
        resolve({
          deviceId: idKey,
          name: record.name,
          size: record.size,
          duration: record.duration
        });
      };

      request.onerror = (event) => {
        console.error('Error saving video blob to IndexedDB:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Retrieve video record for specified deviceId
   * @param {number|string} deviceId 
   * @returns {Promise<Object|null>}
   */
  async getVideo(deviceId) {
    const db = await this.ready();
    const idKey = Number(deviceId);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(idKey);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = (event) => {
        console.error('Error fetching video from IndexedDB:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Delete stored video for specified deviceId
   * @param {number|string} deviceId 
   * @returns {Promise<boolean>}
   */
  async deleteVideo(deviceId) {
    const db = await this.ready();
    const idKey = Number(deviceId);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(idKey);

      request.onsuccess = () => {
        resolve(true);
      };

      request.onerror = (event) => {
        console.error('Error deleting video from IndexedDB:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Clear all stored videos
   */
  async clearAll() {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => resolve(true);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Get storage quota estimate
   */
  async getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        return {
          usage: estimate.usage || 0,
          quota: estimate.quota || 0,
          usageMB: Math.round((estimate.usage || 0) / (1024 * 1024)),
          quotaMB: Math.round((estimate.quota || 0) / (1024 * 1024)),
          percentUsed: estimate.quota ? Math.round((estimate.usage / estimate.quota) * 100) : 0
        };
      } catch (err) {
        console.warn('Storage estimate failed:', err);
      }
    }
    return null;
  }
}

export const videoDB = new VideoDB();
