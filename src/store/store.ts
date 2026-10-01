export type Todo = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly completed: boolean;
  readonly createdAt: string;
};

export interface TodoStore {
  add(ownerEmail: string, todo: Todo): Promise<void>;
  list(ownerEmail: string): Promise<Todo[]>;
  get(ownerEmail: string, id: string): Promise<Todo | undefined>;
  complete(ownerEmail: string, id: string): Promise<Todo | undefined>;
  remove(ownerEmail: string, id: string): Promise<boolean>;
}
