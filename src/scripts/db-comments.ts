import { closeDb } from "../db/client.js";
import { applyDbComments } from "../db/comments.js";

try {
  await applyDbComments();
  console.log("db comments applied");
} finally {
  await closeDb();
}
