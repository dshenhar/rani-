'use strict';

// In-memory copy of all posts and page settings, persisted through the storage
// back end. Writes are serialized, so the app is meant to run as one instance.

const POSTS_KEY = 'meta/posts.json';
const SETTINGS_KEY = 'meta/settings.json';

function createStore(storage, defaults) {
  let posts = [];
  let settings = { name: defaults.name, subtitle: '', cover: null };
  let queue = Promise.resolve();

  function persist(key, getValue) {
    const run = queue.then(() => storage.writeJSON(key, getValue()));
    queue = run.catch(() => {});
    return run;
  }

  return {
    async load() {
      const savedPosts = await storage.readJSON(POSTS_KEY);
      const savedSettings = await storage.readJSON(SETTINGS_KEY);
      if (Array.isArray(savedPosts)) posts = savedPosts;
      if (savedSettings) settings = { ...settings, ...savedSettings };
    },

    posts: () => posts,
    settings: () => settings,
    get: (id) => posts.find((p) => p.id === id),

    async addPost(post) {
      posts = [post, ...posts];
      try {
        await persist(POSTS_KEY, () => posts);
      } catch (err) {
        posts = posts.filter((p) => p !== post);
        throw err;
      }
    },

    async updatePost(id, changes) {
      posts = posts.map((p) => (p.id === id ? { ...p, ...changes } : p));
      await persist(POSTS_KEY, () => posts);
      return posts.find((p) => p.id === id);
    },

    async removePost(id) {
      posts = posts.filter((p) => p.id !== id);
      await persist(POSTS_KEY, () => posts);
    },

    async updateSettings(changes) {
      settings = { ...settings, ...changes };
      await persist(SETTINGS_KEY, () => settings);
      return settings;
    },
  };
}

module.exports = { createStore };
