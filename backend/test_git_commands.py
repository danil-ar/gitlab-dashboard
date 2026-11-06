"""The commands shown for doing a release by hand, run for real against real bare repositories."""
import os
import shutil
import subprocess

import pytest

from app.release_plan import manual_commands

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="needs git")

SHELL = shutil.which("zsh") or "sh"  # zsh is where people paste them; a # line, say, fails only there
ENV = {
    **os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
}


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=ENV, capture_output=True, text=True, check=True).stdout.strip()


def add_commit(cwd, name):
    (cwd / name).write_text(name)
    git(cwd, "add", ".")
    git(cwd, "commit", "-qm", name)
    return git(cwd, "rev-parse", "HEAD")


def paste(cwd, commands):
    """One line after another, stopping at the first failure."""
    return subprocess.run([SHELL, "-c", "set -e\n" + "\n".join(commands)], cwd=cwd, env=ENV, capture_output=True, text=True)


class Project:
    """A bare origin with `target` and a develop two commits ahead, a colleague's clone and yours."""

    def __init__(self, base, target="master"):
        self.origin, self.colleague, self.mine = base / "origin.git", base / "colleague", base / "mine"
        git(base, "init", "-q", "--bare", "-b", target, str(self.origin))
        git(base, "clone", "-q", str(self.origin), str(self.colleague))
        git(self.colleague, "checkout", "-q", "-b", target)
        add_commit(self.colleague, "base")
        git(self.colleague, "push", "-q", "origin", target)
        git(self.colleague, "checkout", "-q", "-b", "develop")
        self.first = add_commit(self.colleague, "feature1")
        self.head = add_commit(self.colleague, "feature2")
        git(self.colleague, "push", "-q", "origin", "develop")
        git(base, "clone", "-q", str(self.origin), str(self.mine))

    def rev(self, name):
        return git(self.origin, "rev-parse", name)

    def tag_contains(self, rev, tag):
        return subprocess.run(["git", "merge-base", "--is-ancestor", rev, tag], cwd=self.origin, env=ENV).returncode == 0


@pytest.fixture
def project(tmp_path):
    return Project(tmp_path)


def test_they_merge_develop_and_tag_the_result(project):
    run = paste(project.mine, manual_commands("develop", "master", project.head, "v1.4.0", True))
    assert run.returncode == 0, run.stderr
    assert project.rev("v1.4.0^{commit}") == project.rev("master")
    assert len(git(project.origin, "log", "-1", "--format=%P", "master").split()) == 2, "a merge commit, as an MR makes"
    assert git(project.origin, "log", "-1", "--format=%s", "master") == "Release v1.4.0: develop into master"
    assert project.tag_contains(project.first, "v1.4.0") and project.tag_contains(project.head, "v1.4.0")
    assert project.first and "v1.4.0" in git(project.origin, "tag", "--contains", project.first).split()


def test_commits_pushed_after_the_preview_stay_out(project):
    commands = manual_commands("develop", "master", project.head, "v1.4.0", True)
    later = add_commit(project.colleague, "after-preview")
    git(project.colleague, "push", "-q", "origin", "develop")
    assert paste(project.mine, commands).returncode == 0
    assert not project.tag_contains(later, "v1.4.0")
    assert project.rev("develop") == later, "develop is left where it was"


def test_nothing_ahead_only_tags_master(project):
    before = project.rev("master")
    run = paste(project.mine, manual_commands("develop", "master", project.head, "v2.0.0", False))
    assert run.returncode == 0, run.stderr
    assert project.rev("master") == before
    assert project.rev("v2.0.0^{commit}") == before


def test_it_works_with_main(tmp_path):
    project = Project(tmp_path, target="main")
    run = paste(project.mine, manual_commands("develop", "main", project.head, "v3.1.0", True))
    assert run.returncode == 0, run.stderr
    assert project.rev("v3.1.0^{commit}") == project.rev("main")


def test_a_diverged_local_master_stops_before_pushing_anything(project):
    git(project.mine, "checkout", "-q", "master")
    add_commit(project.mine, "local-only")
    git(project.colleague, "checkout", "-q", "master")
    add_commit(project.colleague, "remote-only")
    git(project.colleague, "push", "-q", "origin", "master")
    before = project.rev("master")
    assert paste(project.mine, manual_commands("develop", "master", project.head, "v4.0.0", True)).returncode != 0
    assert project.rev("master") == before
    assert "v4.0.0" not in git(project.origin, "tag").split()


def test_an_existing_tag_is_refused_and_not_moved(project):
    git(project.colleague, "tag", "v5.0.0", "master")
    git(project.colleague, "push", "-q", "origin", "v5.0.0")
    before = project.rev("v5.0.0")
    assert paste(project.mine, manual_commands("develop", "master", project.head, "v5.0.0", False)).returncode != 0
    assert project.rev("v5.0.0") == before
