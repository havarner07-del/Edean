# BINOM - expand (a*u^p + b*v^q)^n
# For TI-84 Plus CE Python
# Example: (2x^3 - y)^5
#   a=2 u=x p=3   b=-1 v=y q=1   n=5

def num(s):
  s=s.strip()
  if s=="" or s=="+":
    return 1
  if s=="-":
    return -1
  f=float(s)
  if f==int(f):
    return int(f)
  return f

def ncr(n,k):
  r=1
  for i in range(k):
    r=r*(n-i)//(i+1)
  return r

def pw(v,e):
  if v=="" or e==0:
    return ""
  if e==1:
    return v
  return v+"^"+str(e)

def cstr(c,vars,first):
  # c = coefficient, vars = variable text
  s=""
  if c<0:
    s="-" if first else " - "
    c=-c
  elif not first:
    s=" + "
  if c!=1 or vars=="":
    s=s+str(c)
  return s+vars

def run():
  print("EXPAND (aU^p+bV^q)^n")
  print("Leave var blank for")
  print("a plain number.")
  a=num(input("a (1st coef): "))
  u=input("U (1st var): ").strip()
  p=1
  if u!="":
    p=int(num(input("p (U power): ")))
  b=num(input("b (2nd coef): "))
  v=input("V (2nd var): ").strip()
  q=1
  if v!="":
    q=int(num(input("q (V power): ")))
  n=int(num(input("n (exponent): ")))
  if n<0:
    print("n must be >= 0")
    return

  # build terms: key -> coefficient
  keys=[]
  co={}
  for k in range(n+1):
    c=ncr(n,k)*(a**(n-k))*(b**k)
    e1=p*(n-k)
    e2=q*k
    if u==v:
      # same variable (or both numbers): combine
      key=(u,e1+e2,"",0)
    else:
      key=(u,e1,v,e2)
    if key in co:
      co[key]=co[key]+c
    else:
      co[key]=c
      keys.append(key)

  print("")
  print("RESULT:")
  first=True
  line=0
  for key in keys:
    c=co[key]
    if c==0:
      continue
    t=cstr(c,pw(key[0],key[1])+pw(key[2],key[3]),first)
    first=False
    print(t.strip())
    line=line+1
    if line%8==0:
      input("[enter] more")
  if first:
    print("0")
  print("")
  print("Done.")

run()
