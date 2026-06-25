import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, 'public');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(publicPath));

// Helper: Format millisecond difference to a concise Google-style tag (e.g. +2h, +3d, +5s)
function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `+${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `+${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `+${hours}h`;
  const days = Math.floor(hours / 24);
  return `+${days}d`;
}

// Helper: MD5 Hashing for content comparison
function getFileHash(filePath) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
  } catch (error) {
    console.error(`Error hashing file: ${filePath}`, error);
    return null;
  }
}

// Helper: Recursively scan a folder and gather file details
function scanDirectory(dirPath, recursive = true, baseDir = dirPath) {
  let results = {};
  if (!fs.existsSync(dirPath)) return results;
  
  const stats = fs.statSync(dirPath);
  if (!stats.isDirectory()) return results;

  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const fileStats = fs.statSync(fullPath);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (fileStats.isDirectory()) {
      if (recursive) {
        const subFiles = scanDirectory(fullPath, recursive, baseDir);
        results = { ...results, ...subFiles };
      } else {
        // Track empty folders or folders in non-recursive mode
        results[relativePath] = {
          relativePath,
          name: file,
          size: 0,
          mtimeMs: fileStats.mtimeMs,
          mtime: fileStats.mtime.toISOString(),
          isDirectory: true,
        };
      }
    } else {
      results[relativePath] = {
        relativePath,
        name: file,
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
        mtime: fileStats.mtime.toISOString(),
        isDirectory: false,
      };
    }
  }
  return results;
}

// API Route: Scan and compare left and right folders
app.post('/api/scan', (req, res) => {
  const { leftPath, rightPath, recursive = true } = req.body;

  if (!leftPath || !rightPath) {
    return res.status(400).json({ error: 'Both leftPath and rightPath are required.' });
  }

  const resolvedLeft = path.resolve(leftPath);
  const resolvedRight = path.resolve(rightPath);

  if (!fs.existsSync(resolvedLeft) || !fs.statSync(resolvedLeft).isDirectory()) {
    return res.status(400).json({ error: `Left path does not exist or is not a directory: ${leftPath}` });
  }
  if (!fs.existsSync(resolvedRight) || !fs.statSync(resolvedRight).isDirectory()) {
    return res.status(400).json({ error: `Right path does not exist or is not a directory: ${rightPath}` });
  }

  try {
    const leftFiles = scanDirectory(resolvedLeft, recursive);
    const rightFiles = scanDirectory(resolvedRight, recursive);

    const allPaths = new Set([...Object.keys(leftFiles), ...Object.keys(rightFiles)]);
    const compared = [];

    for (const relPath of allPaths) {
      const leftFile = leftFiles[relPath];
      const rightFile = rightFiles[relPath];

      // File only exists on the left
      if (leftFile && !rightFile) {
        compared.push({
          relativePath: relPath,
          name: leftFile.name,
          isDirectory: leftFile.isDirectory,
          status: 'left-only',
          left: leftFile,
          right: null,
        });
      }
      // File only exists on the right
      else if (!leftFile && rightFile) {
        compared.push({
          relativePath: relPath,
          name: rightFile.name,
          isDirectory: rightFile.isDirectory,
          status: 'right-only',
          left: null,
          right: rightFile,
        });
      }
      // Directory vs Directory (should only occur in non-recursive scans)
      else if (leftFile.isDirectory && rightFile.isDirectory) {
        compared.push({
          relativePath: relPath,
          name: leftFile.name,
          isDirectory: true,
          status: 'identical',
          left: leftFile,
          right: rightFile,
        });
      }
      // File vs File
      else {
        let status = 'identical';
        let newerSide = null;
        let timeDiffStr = '';

        const timeDiffMs = leftFile.mtimeMs - rightFile.mtimeMs;
        if (timeDiffMs > 0) {
          newerSide = 'left';
          timeDiffStr = formatDuration(timeDiffMs);
        } else if (timeDiffMs < 0) {
          newerSide = 'right';
          timeDiffStr = formatDuration(-timeDiffMs);
        }

        // Compare sizes first
        if (leftFile.size !== rightFile.size) {
          status = 'modified';
        } else {
          // If sizes match but modification dates differ, calculate MD5 hashes
          if (timeDiffMs !== 0) {
            const leftFullPath = path.join(resolvedLeft, relPath);
            const rightFullPath = path.join(resolvedRight, relPath);
            
            const leftHash = getFileHash(leftFullPath);
            const rightHash = getFileHash(rightFullPath);

            if (leftHash !== rightHash) {
              status = 'modified';
            }
          }
        }

        compared.push({
          relativePath: relPath,
          name: leftFile.name,
          isDirectory: false,
          status,
          newerSide,
          timeDiffStr,
          left: leftFile,
          right: rightFile,
        });
      }
    }

    res.json({
      leftPath: resolvedLeft,
      rightPath: resolvedRight,
      files: compared,
    });
  } catch (error) {
    console.error('Error during comparison scan:', error);
    res.status(500).json({ error: 'Internal server error scanning folders.' });
  }
});

app.listen(PORT, () => {
  console.log(`Comparer Server running locally at http://localhost:${PORT}`);
});
