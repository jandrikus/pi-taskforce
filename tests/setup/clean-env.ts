// The suite runs as a root session, whatever process started it. Inside a
// pi-taskforce subagent the environment says otherwise, and every test reading
// its own identity would see the subagent's.
for (const key of Object.keys(process.env)) {
	if (key.startsWith("PI_TASKFORCE_")) delete process.env[key];
}
