import { integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const projectStage = pgEnum("project_stage", ["discovery", "blueprint", "building"]);
export const taskStatus = pgEnum("task_status", ["pending", "handed_off", "done", "blocked"]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  oneLiner: text("one_liner").notNull(),
  stage: projectStage("stage").notNull().default("discovery"),
  githubRepo: text("github_repo"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatus("status").notNull().default("pending"),
  },
  (t) => [unique("tasks_project_seq").on(t.projectId, t.seq)],
);
