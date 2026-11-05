import { blogPosts } from "../../lib/blog";

/** Every live post's card fields, newest first: the blog index and "Read next". */
export default defineEventHandler(async (event) => {
  // Short, so a scheduled post shows up within a minute of its time.
  setHeader(event, "cache-control", "public, max-age=60");
  return blogPosts(event);
});
