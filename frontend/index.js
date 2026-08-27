const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const API_URL = process.env.VITE_API_URL ?? "http://localhost:4000";

const html = `<!DOCTYPE html>
<html>
<head><title>Taskflow</title></head>
<body>
  <h1>Taskflow</h1>
  <p>API: ${API_URL}</p>
  <div id="tasks">Loading...</div>
  <script>
    fetch("${API_URL}/api/tasks")
      .then(r => r.json())
      .then(tasks => {
        document.getElementById("tasks").innerHTML =
          tasks.map(t => "<p>" + t.title + "</p>").join("") || "No tasks yet.";
      })
      .catch(e => document.getElementById("tasks").innerHTML = "Error: " + e.message);
  </script>
</body>
</html>`;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}).listen(PORT, "0.0.0.0", () => console.log("taskflow-frontend on :" + PORT));
