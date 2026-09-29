from math import *

def gcd(a,b):
  a=abs(a);b=abs(b)
  while b:
    a,b=b,a%b
  return a

def fr(x):
  s=1
  if x<0:
    s=-1;x=-x
  h0,h1,k0,k1=0,1,1,0
  y=x
  for i in range(20):
    t=int(y)
    h0,h1=h1,t*h1+h0
    k0,k1=k1,t*k1+k0
    if k1>1000:
      return None
    if abs(h1/k1-x)<=1e-7*max(1,x):
      return (s*h1,k1)
    if y-t<1e-12:
      return None
    y=1/(y-t)
  return None

def fmt(x):
  if isinstance(x,int):
    return str(x)
  f=fr(x)
  if f:
    if f[1]==1:
      return str(f[0])
    return str(f[0])+"/"+str(f[1])
  return str(round(x,4))

def num(p):
  while True:
    s=input(p).replace(" ","")
    try:
      if "/" in s:
        a,b=s.split("/")
        x=float(a)/float(b)
      else:
        x=float(s)
      if x==int(x):
        return int(x)
      return x
    except:
      print("Try again")

def wait():
  input("[enter]")

def fa(n):
  r=1
  for i in range(2,n+1):
    r*=i
  return r

def ncr(n,k):
  if k<0 or k>n:
    return 0
  r=1
  for i in range(k):
    r=r*(n-i)//(i+1)
  return r

def npr(n,r):
  return fa(n)//fa(n-r)

def pw(v,e):
  if v=="" or e==0:
    return ""
  if e==1:
    return v
  return v+"^"+str(e)

def term(c,vs,first):
  s=""
  if c<0:
    s="-" if first else "- "
    c=-c
  elif not first:
    s="+ "
  if c!=1 or vs=="":
    s=s+fmt(c)
  return s+vs

def binom():
  print("(aU^p + bV^q)^n")
  print("Blank var = just a number")
  a=num("a=");u=input("U=").strip();p=1
  if u:
    p=int(num("p="))
  b=num("b=");v=input("V=").strip();q=1
  if v:
    q=int(num("q="))
  n=int(num("n="))
  print("1 Full expansion")
  print("2 k-th term")
  print("3 Term with U^m")
  print("4 Pascal row n")
  c=num("? ")
  if c==4:
    print(" ".join([str(ncr(n,k)) for k in range(n+1)]))
    return
  if c==1:
    ks=range(n+1)
  elif c==2:
    ks=[int(num("k (1st term=1)="))-1]
  else:
    m=num("m=")
    ks=[n-m/p] if u else []
    if not ks or ks[0]!=int(ks[0]) or not 0<=ks[0]<=n:
      print("No such term")
      return
    ks=[int(ks[0])]
  j=0
  for k in ks:
    cf=ncr(n,k)*a**(n-k)*b**k
    vs=pw(u,p*(n-k))+pw(v,q*k)
    if c==1:
      print(term(cf,vs,k==0))
      j+=1
      if j%9==0 and k<n:
        wait()
    else:
      print("Term #"+str(k+1)+" = C("+str(n)+","+str(k)+")")
      print(" ("+fmt(a)+")^"+str(n-k)+"("+fmt(b)+")^"+str(k)+"..")
      print("= "+term(cf,vs,True))

def word():
  print("Word (MISSISSIPPI) or")
  s=input("counts (4,4,2,1): ").replace(" ","")
  if "," in s or s.isdigit():
    cs=[int(x) for x in s.split(",")]
  else:
    d={}
    for ch in s.upper():
      d[ch]=d.get(ch,0)+1
    cs=[]
    for ch in d:
      cs.append(d[ch])
      if d[ch]>1:
        print(ch+" x"+str(d[ch]))
  n=sum(cs);den=1;t=""
  for x in cs:
    den*=fa(x)
    if x>1:
      t=t+str(x)+"!"
  print(str(n)+"!/"+(t or "1")+" = "+str(fa(n)//den))

def fund():
  print("Choices at each step,")
  print("blank to finish")
  r=1
  while True:
    s=input("choices: ").strip()
    if not s:
      break
    r*=int(s)
  print("Total = "+str(r))

def form():
  print("n! = n(n-1)...1  0!=1")
  print("nPr = n!/(n-r)!  ORDER")
  print("nCr = n!/(r!(n-r)!) NO ord")
  print("Fund: m*n*... ways")
  print("Repeats: n!/(n1!n2!...)")
  print("Circle: (n-1)!")
  print("Binomial k-th term:")
  print(" C(n,k-1)a^(n-k+1)b^(k-1)")
  print("(a+b)^n: sum C(n,k)")
  print("  a^(n-k) b^k, k=0..n")
  wait()

while True:
  print("== COUNTING (Ch 11) ==")
  print("1 n!    2 nPr   3 nCr")
  print("4 Binomial theorem")
  print("5 Arrange letters/repeats")
  print("6 Fundamental counting")
  print("7 Circular (n-1)!")
  print("8 Formulas  0 Quit")
  c=num("? ")
  if c==0:
    break
  print("")
  try:
    if c==1:
      n=int(num("n="))
      print(str(n)+"! = "+str(fa(n)))
    elif c==2 or c==3:
      n=int(num("n="));r=int(num("r="))
      if c==2:
        print("P("+str(n)+","+str(r)+") = "+str(npr(n,r)))
      else:
        print("C("+str(n)+","+str(r)+") = "+str(ncr(n,r)))
    elif c==7:
      n=int(num("n="))
      print("("+str(n)+"-1)! = "+str(fa(n-1)))
    else:
      [0,0,0,0,binom,word,fund,0,form][c]()
  except Exception as x:
    print("Error: "+str(x))
  wait()
