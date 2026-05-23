#!/usr/bin/bash

set -euo pipefail

# 1. read local version from package.json
version=$(node -p "require('./package.json').version")
tag_name="v${version}"

# 2. check if the tag reference already exists on remote
# query the exact tag ref directly from remote to avoid grep mismatch
if [ -n "$(git ls-remote --tags origin "refs/tags/${tag_name}")" ]; then
    echo "warning: tag ${tag_name} already exists on remote repository!"
    read -p "do you want to bump the patch version and continue? (y/n): " choice
    
    if [[ "$choice" =~ ^[Yy]$ ]]; then
        echo "bumping patch version..."
        # automatically update patch version in package.json (e.g., 1.0.0 -> 1.0.1)
        npm version patch --no-git-tag-version
        
        # re-read the updated version
        version=$(node -p "require('./package.json').version")
        tag_name="v${version}"
        
        # commit version changes and push to remote
        git add package.json
        git commit -m "chore: bump version to ${version}"
        git push origin HEAD
    else
        echo "release cancelled."
        exit 0
    fi
else
    echo "no remote conflict found for ${tag_name}, continuing release process..."
fi

# 3. tag the latest commit locally
# remove existing local tag if it conflicts to prevent fatal error
if git rev-parse "${tag_name}" >/dev/null 2>&1; then
    echo "local tag ${tag_name} already exists, overwriting it..."
    git tag -d "${tag_name}"
fi
git tag -a "${tag_name}" -m "release version ${version}"

# 4. push the new tag to remote repository
# using -f (--force) to forcefully overwrite the remote tag and break the loop
git push -f origin "${tag_name}"

# 5. invoke the build script to generate artifacts
echo "starting build process..."
./build-all.sh

# 6. create github release and upload all matching files
echo "creating github release and uploading artifacts..."
gh release create "${tag_name}" \
    ./release/UNO-"${tag_name}"_* \
    --title "${tag_name}" \
    --generate-notes

echo "release successful! current online version is ${tag_name}"
