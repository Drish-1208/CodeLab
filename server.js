const Fastify = require('fastify');
const cors = require('@fastify/cors');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs/promises');
const path = require('path');
const { simpleGit } = require('simple-git');require('dotenv').config();
const fastify = Fastify({ logger: true });
const { Server } = require('socket.io');

// Attach Socket.IO to Fastify's HTTP server
const io = new Server(fastify.server, {
  cors: {
    origin: '*', // Matches your Fastify CORS config
    methods: ['GET', 'POST', 'PUT']
  }
});

fastify.register(cors, { origin: '*' });

// Initialize Supabase Client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

fastify.get('/ping', async (request, reply) => {
  return { project: 'CodeLab', status: 'Backend is running!' };
});

// New Route: Fetch all projects
fastify.get('/projects', async (request, reply) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*');
    
  if (error) {
    return reply.status(500).send({ error: error.message });
  }
  return { projects: data };
});

// POST: Create a new project
// POST: Create a new project
fastify.post('/projects', async (request, reply) => {
  const { name, description, owner_id } = request.body;

  // 1. Insert the project into Supabase
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .insert([{ name, description, owner_id }])
    .select()
    .single();

  if (projectError) return reply.status(500).send({ error: projectError.message });

  // 2. Add the creator as the owner in project_members
  const { error: memberError } = await supabase
    .from('project_members')
    .insert([{ project_id: project.id, user_id: owner_id, role: 'owner' }]);

  if (memberError) return reply.status(500).send({ error: memberError.message });

  // 3. Create the physical directory on the server
  const projectPath = path.join(__dirname, 'storage', 'projects', project.id);
  await fs.mkdir(projectPath, { recursive: true });
  
  // 4. Initialize Git and create the first commit
  const git = simpleGit(projectPath);
  await git.init();
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\nInitialized by CodeLab.`);
  await git.add('.').commit('Initial commit');

  return reply.status(201).send({ project, message: 'Project and Git repository created successfully' });
});

// POST: Initialize a private workspace
fastify.post('/workspaces', async (request, reply) => {
  const { project_id, user_id, username } = request.body;
  const branch_name = `${username}-workspace`;

  // 1. Check if an active workspace already exists in the database
  const { data: existingWorkspace } = await supabase
    .from('workspaces')
    .select('*')
    .eq('project_id', project_id)
    .eq('user_id', user_id)
    .eq('status', 'active')
    .single();

  if (existingWorkspace) {
    return reply.send({ workspace: existingWorkspace, message: 'Resuming existing workspace' });
  }

  // 2. Create a new active workspace record in Supabase
  const { data: newWorkspace, error } = await supabase
    .from('workspaces')
    .insert([{ project_id, user_id, branch_name, status: 'active' }])
    .select()
    .single();

  if (error) return reply.status(500).send({ error: error.message });

  // 3. Define the physical folder paths
  const projectPath = path.join(__dirname, 'storage', 'projects', project_id);
  const workspacePath = path.join(__dirname, 'storage', 'workspaces', newWorkspace.id);

  // 4. Clone the main project repository into the user's private folder
  await simpleGit().clone(projectPath, workspacePath);

  // 5. Switch the isolated folder to the user's unique branch
  const workspaceGit = simpleGit(workspacePath);
  await workspaceGit.checkoutLocalBranch(branch_name);

  return reply.status(201).send({ workspace: newWorkspace, message: 'New private workspace initialized' });
});

// Helper function to build a file tree for the IDE sidebar
async function getDirectoryTree(dirPath, basePath = '') {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const tree = [];

  for (const entry of entries) {
    // Ignore the hidden Git folder
    if (entry.name === '.git') continue;

    const relativePath = path.join(basePath, entry.name);
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      tree.push({
        name: entry.name,
        type: 'directory',
        path: relativePath,
        children: await getDirectoryTree(fullPath, relativePath),
      });
    } else {
      tree.push({
        name: entry.name,
        type: 'file',
        path: relativePath,
      });
    }
  }
  return tree;
}

// GET: Fetch the complete file tree for the workspace
fastify.get('/workspaces/:workspaceId/files', async (request, reply) => {
  const { workspaceId } = request.params;
  const workspacePath = path.join(__dirname, 'storage', 'workspaces', workspaceId);

  try {
    const tree = await getDirectoryTree(workspacePath);
    return reply.send({ tree });
  } catch (error) {
    return reply.status(500).send({ error: 'Failed to read workspace directory' });
  }
});

// GET: Read the content of a specific file
fastify.get('/workspaces/:workspaceId/file', async (request, reply) => {
  const { workspaceId } = request.params;
  const { filePath } = request.query; // Passed as a query param, e.g., ?filePath=auth.js

  const workspacePath = path.join(__dirname, 'storage', 'workspaces', workspaceId);
  const targetPath = path.join(workspacePath, filePath);

  // Security check to prevent directory traversal attacks
  if (!targetPath.startsWith(workspacePath)) {
    return reply.status(403).send({ error: 'Invalid file path' });
  }

  try {
    const content = await fs.readFile(targetPath, 'utf-8');
    return reply.send({ content });
  } catch (error) {
    return reply.status(500).send({ error: 'Failed to read file' });
  }
});

// PUT: Save code edits to a specific file
fastify.put('/workspaces/:workspaceId/file', async (request, reply) => {
  const { workspaceId } = request.params;
  const { filePath, content } = request.body;

  const workspacePath = path.join(__dirname, 'storage', 'workspaces', workspaceId);
  const targetPath = path.join(workspacePath, filePath);

  if (!targetPath.startsWith(workspacePath)) {
    return reply.status(403).send({ error: 'Invalid file path' });
  }

  try {
    await fs.writeFile(targetPath, content, 'utf-8');
    return reply.send({ message: 'File saved successfully' });
  } catch (error) {
    return reply.status(500).send({ error: 'Failed to save file' });
  }
});

// POST: Publish local workspace changes to the shared project
fastify.post('/workspaces/:workspaceId/publish', async (request, reply) => {
  const { workspaceId } = request.params;
  const { commitMessage } = request.body;

  // 1. Fetch workspace details from Supabase to get the branch name
  const { data: workspace, error } = await supabase
    .from('workspaces')
    .select('*')
    .eq('id', workspaceId)
    .single();

  if (error || !workspace) {
    return reply.status(404).send({ error: 'Workspace not found' });
  }

  const workspacePath = path.join(__dirname, 'storage', 'workspaces', workspaceId);
  const git = simpleGit(workspacePath);

  try {
    // 2. Stage all local edits
    await git.add('./*');

    // 3. Commit the changes
    await git.commit(commitMessage || 'Published changes from workspace');

    // 4. Push the branch to the main project repository (the 'origin')
    await git.push('origin', workspace.branch_name);

    // 5. Update the last active timestamp in Supabase
    await supabase
      .from('workspaces')
      .update({ last_committed_at: new Date().toISOString() })
      .eq('id', workspaceId);

    return reply.send({ 
      message: 'Changes published successfully', 
      branch: workspace.branch_name 
    });
  } catch (gitError) {
    fastify.log.error(gitError);
    return reply.status(500).send({ error: 'Failed to publish changes via Git' });
  }
});

// POST: Create a Change Request (Code Review)
fastify.post('/projects/:projectId/change-requests', async (request, reply) => {
  const { projectId } = request.params;
  const { author_id, title, source_branch } = request.body;

  const { data: changeRequest, error } = await supabase
    .from('change_requests')
    .insert([{ 
      project_id: projectId, 
      author_id, 
      title, 
      source_branch,
      status: 'open'
    }])
    .select()
    .single();

  if (error) return reply.status(500).send({ error: error.message });

  return reply.status(201).send({ 
    changeRequest, 
    message: 'Change request opened and ready for review' 
  });
});

// GET: Fetch the Git diff for a specific change request
fastify.get('/projects/:projectId/change-requests/:requestId/diff', async (request, reply) => {
  const { projectId, requestId } = request.params;

  // 1. Fetch the change request to identify the source branch
  const { data: changeRequest, error } = await supabase
    .from('change_requests')
    .select('source_branch')
    .eq('id', requestId)
    .single();

  if (error || !changeRequest) {
    return reply.status(404).send({ error: 'Change request not found' });
  }

  const projectPath = path.join(__dirname, 'storage', 'projects', projectId);
  const git = simpleGit(projectPath);

  try {
    // 2. Generate the diff between the main branch (master) and the user's branch
    // Note: If your default branch is 'main', change 'master' to 'main' below.
    const diffSummary = await git.diff(['master', changeRequest.source_branch]);
    
    return reply.send({ diff: diffSummary });
  } catch (gitError) {
    fastify.log.error(gitError);
    return reply.status(500).send({ error: 'Failed to generate diff' });
  }
});

// POST: Approve and merge a change request
fastify.post('/projects/:projectId/change-requests/:requestId/merge', async (request, reply) => {
  const { projectId, requestId } = request.params;

  // 1. Verify the change request is open
  const { data: changeRequest, error } = await supabase
    .from('change_requests')
    .select('*')
    .eq('id', requestId)
    .eq('status', 'open')
    .single();

  if (error || !changeRequest) {
    return reply.status(400).send({ error: 'Invalid or already processed change request' });
  }

  const projectPath = path.join(__dirname, 'storage', 'projects', projectId);
  const git = simpleGit(projectPath);

  try {
    // 2. Perform the Git merge operation
    await git.checkout('master');
    await git.merge([changeRequest.source_branch]);
    
    // Optional: Delete the branch after merging to keep the repo clean
    // await git.branch(['-D', changeRequest.source_branch]);

    // 3. Mark the change request as merged in Supabase
    await supabase
      .from('change_requests')
      .update({ status: 'merged' })
      .eq('id', requestId);

    // 4. Update the user's workspace status
    await supabase
      .from('workspaces')
      .update({ status: 'merged' })
      .eq('project_id', projectId)
      .eq('branch_name', changeRequest.source_branch);

    return reply.send({ message: 'Code successfully merged into the main project' });
  } catch (gitError) {
    fastify.log.error(gitError);
    return reply.status(500).send({ error: 'Merge conflict or Git failure' });
  }
});

// WebSocket: Live File Presence Event Loop
io.on('connection', (socket) => {
  fastify.log.info(`Client connected via WebSocket: ${socket.id}`);

  // 1. User enters a project workspace
  socket.on('join-project', ({ projectId, username }) => {
    socket.join(projectId); // Group users into a "room" by project ID
    socket.projectId = projectId;
    socket.username = username;
    
    // Announce to teammates that this user is online
    socket.to(projectId).emit('teammate-joined', { username });
  });

  // 2. User clicks on a file in the IDE explorer
  socket.on('file-focus', ({ filePath }) => {
    if (socket.projectId && socket.username) {
      // Broadcast exactly which file they are looking at to the rest of the team
      socket.to(socket.projectId).emit('presence-update', {
        username: socket.username,
        filePath: filePath,
        status: 'editing'
      });
    }
  });

  // 3. User closes the file or clicks away
  socket.on('file-blur', () => {
    if (socket.projectId && socket.username) {
      socket.to(socket.projectId).emit('presence-update', {
        username: socket.username,
        filePath: null,
        status: 'idle'
      });
    }
  });

  // 4. User closes the browser tab
  socket.on('disconnect', () => {
    if (socket.projectId && socket.username) {
      socket.to(socket.projectId).emit('presence-update', {
        username: socket.username,
        filePath: null,
        status: 'disconnected'
      });
    }
  });
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000 });
    console.log('CodeLab server is listening on port 3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();