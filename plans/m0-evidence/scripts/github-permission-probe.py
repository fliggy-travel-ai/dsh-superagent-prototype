import json,os,subprocess,sys,time
T=os.environ["GH_TOKEN"]
def get(path,retries=3):
    for i in range(retries):
        p=subprocess.run(["curl","-sS","--max-time","25","-D","-","-o","/tmp/ghprobe/body.out","-H","Authorization: Bearer "+T,"-H","Accept: application/vnd.github+json","-H","X-GitHub-Api-Version: 2022-11-28","https://api.github.com"+path],capture_output=True,text=True)
        if p.returncode==0 and p.stdout.startswith("HTTP"):
            lines=p.stdout.splitlines(); code=int(lines[0].split()[1]); h={}
            for l in lines[1:]:
                if ":" in l:
                    k,v=l.split(":",1); h[k.strip().lower()]=v.strip()
            try: body=json.load(open("/tmp/ghprobe/body.out"))
            except Exception: body=None
            return code,h,body
        time.sleep(1.5)
    return -1,{},None
org="fliggy-travel-ai"
repos=[r["name"] for r in get(f"/orgs/{org}/repos?per_page=100")[2]]
res={}
def rec(row,name,path):
    s,h,b=get(path); row[name]=[s,h.get("x-accepted-github-permissions")]
    print(" ",name,s,h.get("x-accepted-github-permissions"),flush=True)
    return s,b
for rp in repos:
    print("==",rp,flush=True); row={}; res[rp]=row
    rec(row,"issues",f"/repos/{org}/{rp}/issues?state=all&sort=updated&direction=asc&per_page=1&since=2026-11-01T00:00:00Z")
    rec(row,"issue_comments",f"/repos/{org}/{rp}/issues/comments?sort=updated&direction=asc&per_page=1&since=2026-11-01T00:00:00Z")
    rec(row,"pulls_comments",f"/repos/{org}/{rp}/pulls/comments?sort=updated&direction=asc&per_page=1&since=2026-11-01T00:00:00Z")
    rec(row,"actions_runs",f"/repos/{org}/{rp}/actions/runs?per_page=5")
    s,prs=rec(row,"pulls_list",f"/repos/{org}/{rp}/pulls?state=all&per_page=1")
    if s==200 and prs:
        n=prs[0]["number"]; sha=prs[0]["head"]["sha"]
        rec(row,"pull_detail",f"/repos/{org}/{rp}/pulls/{n}")
        rec(row,"pull_reviews",f"/repos/{org}/{rp}/pulls/{n}/reviews")
        rec(row,"check_runs",f"/repos/{org}/{rp}/commits/{sha}/check-runs")
        rec(row,"commit_status",f"/repos/{org}/{rp}/commits/{sha}/status")
json.dump(res,open("/tmp/ghprobe/result.json","w"),ensure_ascii=False,indent=1)
print("DONE")
