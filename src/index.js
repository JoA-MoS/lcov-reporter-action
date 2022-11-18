import { promises as fs } from "fs"
import core from "@actions/core"
import { GitHub, context } from "@actions/github"
import path from "path"

import { parse } from "./lcov"
import { diff } from "./comment"
import { getChangedFiles } from "./get_changes"
import { deleteOldComments } from "./delete_old_comments"
import { normalisePath } from "./util"

const MAX_COMMENT_CHARS = Infinity

async function main() {
	const token = core.getInput("github-token")
	const githubClient = new GitHub(token)
	const workingDir = core.getInput("working-directory") || "./"
	const lcovFile = path.join(
		workingDir,
		core.getInput("lcov-file") || "./coverage/lcov.info",
	)
	const baseFile = core.getInput("lcov-base")
	const shouldFilterChangedFiles =
		core.getInput("filter-changed-files").toLowerCase() === "true"
	const shouldDeleteOldComments =
		core.getInput("delete-old-comments").toLowerCase() === "true"
	const title = core.getInput("title")

	const omitStatementPercentage =
		core.getInput("omit-statement-percentage").toLowerCase() === "true"
	const omitBranchPercentage =
		core.getInput("omit-branch-percentage").toLowerCase() === "true"
	const omitFunctionPercentage =
		core.getInput("omit-function-percentage").toLowerCase() === "true"
	const omitLinePercentage =
		core.getInput("omit-line-percentage").toLowerCase() === "true"
	const omitUncoveredLines =
		core.getInput("omit-uncovered-lines").toLowerCase() === "true"

	const raw = await fs.readFile(lcovFile, "utf-8").catch(err => null)
	if (!raw) {
		console.log(`No coverage report found at '${lcovFile}', exiting...`)
		return
	}

	const baseRaw =
		baseFile && (await fs.readFile(baseFile, "utf-8").catch(err => null))
	if (baseFile && !baseRaw) {
		console.log(`No coverage report found at '${baseFile}', ignoring...`)
	}

	const options = {
		repository: context.payload.repository.full_name,
		prefix: normalisePath(`${process.env.GITHUB_WORKSPACE}/`),
		workingDir,
	}

	if (context.eventName === "pull_request") {
		options.commit = context.payload.pull_request.head.sha
		options.baseCommit = context.payload.pull_request.base.sha
		options.head = context.payload.pull_request.head.ref
		options.base = context.payload.pull_request.base.ref
	} else if (context.eventName === "push") {
		options.commit = context.payload.after
		options.baseCommit = context.payload.before
		options.head = context.ref
	}

	options.shouldFilterChangedFiles = shouldFilterChangedFiles
	options.title = title
	options.omitStatementPercentage = omitStatementPercentage
	options.omitBranchPercentage = omitBranchPercentage
	options.omitFunctionPercentage = omitFunctionPercentage
	options.omitLinePercentage = omitLinePercentage
	options.omitUncoveredLines = omitUncoveredLines

	if (shouldFilterChangedFiles) {
		options.changedFiles = await getChangedFiles(githubClient, options, context)
	}

	const lcov = await parse(raw)
	const baselcov = baseRaw && (await parse(baseRaw))
	let body = diff(lcov, baselcov, options)
	if (body.length > MAX_COMMENT_CHARS) {
		console.warn(
			`PR Comment length of ${body.length} is greater than the max comment length of ${MAX_COMMENT_CHARS}`,
		)
		body = body.substring(0, MAX_COMMENT_CHARS)
	}

	if (shouldDeleteOldComments) {
		await deleteOldComments(githubClient, options, context)
	}

	if (context.eventName === "pull_request") {
		await githubClient.issues.createComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			issue_number: context.payload.pull_request.number,
			body: body,
		})
	} else if (context.eventName === "push") {
		await githubClient.repos.createCommitComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			commit_sha: options.commit,
			body: body,
		})
	}
}

main().catch(function(err) {
	console.log(err)
	core.setFailed(err.message)
})
