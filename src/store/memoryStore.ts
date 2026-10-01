import type { Todo, TodoStore } from "./store.js";

export function createMemoryStore(): TodoStore {
  const data = new Map<string, Map<string, Todo>>();

  const forOwner = (email: string): Map<string, Todo> => {
    if (!data.has(email)) data.set(email, new Map());
    return data.get(email)!;
  };

  return {
    async add(owner, todo) {
      forOwner(owner).set(todo.id, todo);
    },
    async list(owner) {
      return [...forOwner(owner).values()];
    },
    async get(owner, id) {
      return forOwner(owner).get(id);
    },
    async complete(owner, id) {
      const todos = forOwner(owner);
      const todo = todos.get(id);
      if (!todo) return undefined;
      const updated = { ...todo, completed: true };
      todos.set(id, updated);
      return updated;
    },
    async remove(owner, id) {
      return forOwner(owner).delete(id);
    },
  };
}
